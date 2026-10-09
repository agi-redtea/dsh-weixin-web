/**
 * dsh-weixin-web：微信 ClawBot (iLink) 通道插件（标准 cordis bundle 形态）。
 *
 * 数据流：
 *   iLink getupdates 长轮询收消息 → 按微信用户映射/创建 Harness 会话
 *   → agent.followup(userMessage) 原生注入
 *   → 订阅 session/event（user/message 按 id 关联 → assistant/message 收集
 *     → turn/end 结算）→ sendmessage 回微信（带 context_token）
 */

import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import * as ilink from './ilink.mjs'
import { defaultAttachmentsRoot, resolveSendableFile } from './files.mjs'
import fsp from 'node:fs/promises'
import { createStore, resolveStateDir, resolveWorkspaceDir } from './creds.mjs'
import { registerWeixinTransport } from './rpc.mjs'
import { WeixinWorkspace, applySessionTitle, defaultBotName, weixinSessionTitle } from './workspace.mjs'
import { WeixinHub } from './hub.mjs'
import { normalizeSettings, overrideRequestModel, personaPromptText } from './settings.mjs'

export const name = 'dsh-weixin-web'
/**
 * 硬依赖：connection.rpc.handle 内部通过调用方 ctx 读取 webServer 注册 RPC 路由，缺 webServer 会在 apply 时抛
 * 「cannot get property "webServer" without inject」，整个插件激活失败（DSH 0.2.0-rc.2 实测）；
 * 通道需要 agents（查找/创建/恢复代理）；tools 用于注册主动推送工具；attachments 用于收图（存图喂视觉模型）。agentPresets 为可选探测。
 */
export const inject = ['webServer', 'agents', 'tools', 'attachments', 'connection']

/** 可配置参数（默认值即 schema 默认，可在 cordis.yml 覆盖）。 */
export const Config = Schema.object({
  // 新会话的工作目录（绝对路径，决定会话持久化命名空间与文件工具根）；
  // 空 = 自动（stateDir/workspace，跨重启稳定）
  cwd: Schema.string().default(''),
  // 状态目录（凭证/会话映射/游标）；空 = 自动（$DSH_HOME/dsh-weixin-web 或 ~/.dsh/dsh-weixin-web）
  stateDir: Schema.string().default(''),
  // 回复风格：full 整轮文本 / last 只回最后一条
  replyMode: Schema.union(['full', 'last']).default('full'),
  // 单轮回复超时（毫秒）
  replyTimeoutMs: Schema.number().default(15 * 60_000),
  // 单条消息最大字符数（超出切分）
  maxChunk: Schema.number().default(1500),
  // 两条发送之间的最小间隔（毫秒，规避 iLink 限流）
  sendIntervalMs: Schema.number().default(2000),
  // 微信会话的审批策略：never = 需要审批的操作直接拒绝（微信端无人能点「批准」，ask 会让整轮永久挂起）
  approvalPolicy: Schema.union(['never', 'ask']).default('never'),
  // 扫码登录使用的 iLink 地址；空 = 官方地址（仅用于本地彩排/测试指向模拟服务）
  loginBaseUrl: Schema.string().default(''),
  // 微信 CDN 地址（收发图片/文件/视频）；空 = 官方 CDN。设置后所有下载/上传都只走这里（忽略服务端给的完整 URL），
  // 用于本地彩排/测试指向模拟 CDN，保证不碰真实 CDN
  cdnBaseUrl: Schema.string().default(''),
  // 单个媒体（图片/文件/视频）大小上限（字节），默认 20MB
  maxMediaBytes: Schema.number().default(20 * 1024 * 1024),
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 可被 AbortSignal 打断的等待（登出 / 重新登录时立即结束退避或暂停）。 */
function abortableSleep(ms, signal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() { clearTimeout(t); signal?.removeEventListener?.('abort', done); resolve() }
    signal?.addEventListener?.('abort', done, { once: true })
  })
}

/** 长轮询连续失败的退避：1s、2s、4s … 封顶 30s。 */
export function pollBackoffMs(failures) {
  return Math.min(1000 * 2 ** Math.max(0, failures - 1), 30_000)
}

/** 会话过期（errcode -14）后暂停轮询的时长；期间重新扫码会立即打断暂停。 */
export const SESSION_EXPIRED_PAUSE_MS = 30 * 60_000

/** resume 撞上「写句柄被占用」时的重试次数与间隔（约 10 秒，覆盖启动时与 DSH 自己抢同一会话）。 */
export const WRITER_HELD_ATTEMPTS = 40
export const WRITER_HELD_GAP_MS = 250

/** DSH 0.2：同一会话已有写句柄（本进程 agents 正在打开，或 flock 被占用）时 resume 会失败。 */
export function isWriterHeldError(err) {
  if (!err || typeof err !== 'object') return false
  if (err.name === 'SessionAlreadyOwnedError' || err.code === 'session/writer-held') return true
  return /already owned by an active write handle/.test(String(err.message ?? ''))
}

/** 连续失败达到该次数即视为通道不健康（connected=false）。 */
const UNHEALTHY_FAILURES = 3

/** 登录终态（confirmed/error/expired）后面板保留最终提示的时长，之后自动收起卡片（review S3）。 */
const LOGIN_DONE_GRACE_MS = 10_000

export function chunkText(text, max) {
  const limit = Math.max(1, Math.floor(max || 1500))
  const out: string[] = []
  let rest = text ?? ''
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit / 2) cut = limit
    // 切点不得落在 UTF-16 代理对之间（emoji 占 2 码元）。优先左移一格，把整个字符留给
    // 下一块；若已顶到块首（如 maxChunk=1 且以 emoji 开头）无法左移，则右移一格把整个
    // 字符纳入本块——宁可本块超 1 码元，也不产出半个字符，并保证 rest 一定前进。
    if (cut > 0 && cut < rest.length) {
      const prev = rest.charCodeAt(cut - 1)
      const next = rest.charCodeAt(cut)
      if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        cut = cut - 1 > 0 ? cut - 1 : cut + 1
      }
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) out.push(rest)
  return out
}

/** 等价 @deepseek-ai/dsh-llm 的 createUserMessage（避免依赖独立安装时版本漂移）。 */
function makeUserMessage(input) {
  return { ...input, role: 'user', id: `msg-${randomUUID()}` }
}

/**
 * 单个微信机器人（一个 bot_token）的通道：一个长轮询 loop 与若干按微信用户隔离的会话。
 * 多机器人由 WeixinHub 为每个机器人各建一个通道。
 * options.workspace：共享的「微信」工作区（不传则自建）。
 */
export class WeixinChannel {
  [key: string]: any
  constructor(ctx, config, store, options: any = {}) {
    this.ctx = ctx
    this.cfg = config
    this.store = store
    this.log = ctx.logger ?? console
    this.creds = store.loadCredentials()
    this.sessionMap = store.loadSessionMap()
    this.buf = store.loadBuf()
    this.botAgent = 'DeepSeek Harness Weixin Channel'
    this.typingTickets = new Map()
    this.turns = new Map() // sessionId -> current turn
    this.pending = new Map() // userMessage.id -> {from, contextToken, sessionId, resolve, timer}
    this.collectors = new Map() // sessionId -> { sessionId, turn, msgId, parts, pending }（每个会话独立收集，支持多用户并发）
    this.inboundQueues = new Map() // userId -> 该用户入站处理链的尾部 Promise（同一用户串行、不同用户并行）
    this.contextTokens = new Map() // userId -> 最近一次入站携带的 context_token（发送时优先用最新的）
    this.lastSendAt = 0
    this.sendQueue = Promise.resolve() // 发送调速队列（review S6）
    this.stopped = false
    this.monitorRunning = false
    this.monitorAbort = new AbortController()
    this.status = { baseUrl: null, lastEventAt: null, lastError: null, startedAt: Date.now(), failures: 0, needsRelogin: false }
    this.getUpdates = ilink.getUpdates // 测试注入点
    this.notifyStart = ilink.notifyStart // 测试注入点
    this.sleep = abortableSleep // 测试注入点：(ms, signal) => Promise
    this.logs = [] // ring buffer
    this.login = null // 面板登录流程状态
    this.downloadImageBytes = ilink.downloadImageBytes // 测试注入点（默认走 CDN 下载解密）
    this.uploadMedia = ilink.uploadMedia // 测试注入点（默认加密上传到 CDN）
    this.visionCache = new Map() // `provider:model` -> boolean（模型是否支持图片输入）
    this.contactActivity = new Map() // 微信用户 id -> { lastMessageAt, preview, direction }（仅内存，面板「最近消息」用）
    this.workspace = options.workspace ?? new WeixinWorkspace(ctx, config.cwd, (line) => this.pushLog(line)) // 「微信」工作区分组
    this.logTag = options.logTag ?? null // () => string：多机器人时给日志加机器人名前缀
    this.onActivity = options.onActivity ?? null // (userId, entry) => void：hub 持久化最近消息
    for (const [k, v] of Object.entries(options.activity ?? {})) this.contactActivity.set(k, v)
    this.paused = false // 暂停收消息（凭据 enabled=false）

    // 保存监听释放函数：解绑机器人时要摘掉本通道的监听（cordis ctx.on 返回 dispose）
    this.disposers = [
      this.ctx.on('session/event', (session, event) => this.handleSessionEvent(session, event)),
      this.ctx.on('dispose', () => this.stop()),
    ]

    if (this.creds?.bot_token && this.creds.enabled === false) {
      this.paused = true
      this.pushLog('机器人已暂停，不收消息（可在微信抽屉中恢复）')
    } else if (this.creds?.bot_token) {
      this.startMonitor()
    } else {
      this.pushLog('未配置微信凭据，等待 DSH 原生扫码登录')
    }
  }

  /** 记录联系人最近一条消息（收/发），供 DSH 抽屉展示预览与时间。 */
  noteActivity(userId, direction, text) {
    if (!userId) return
    const preview = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
    const entry = { lastMessageAt: Date.now(), preview, direction }
    this.contactActivity.set(userId, entry)
    try { this.onActivity?.(userId, entry) } catch { /* 持久化失败不影响收发 */ }
  }

  /**
   * 启动时为还没有「最近消息」记录的联系人，从会话历史里取最后一条文字消息作为预览（尽力而为）。
   * 使用宿主 Session.snapshotEvents（同步读，宿主标记为不推荐新用）；取不到就跳过。
   */
  seedActivityFromSession(userId, agent) {
    if (!userId || this.contactActivity.has(userId)) return
    try {
      const events = agent?.session?.snapshotEvents?.()
      if (!Array.isArray(events)) return
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e?.type !== 'user/message' && e?.type !== 'assistant/message') continue
        const content = e.type === 'user/message' ? (e.data?.content ?? e.data?.message?.content) : e.data?.message?.content
        const text = typeof content === 'string' ? content
          : (Array.isArray(content) ? content : []).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ')
        const preview = text.replace(/\s+/g, ' ').trim().slice(0, 80)
        if (!preview) continue
        const entry = { lastMessageAt: typeof e.time === 'number' ? e.time : null, preview, direction: e.type === 'user/message' ? 'inbound' : 'outbound' }
        this.contactActivity.set(userId, entry)
        try { this.onActivity?.(userId, entry) } catch { /* ignore */ }
        return
      }
    } catch { /* 宿主不支持就算了 */ }
  }

  pushLog(line) {
    const entry = `[${new Date().toISOString().slice(11, 19)}] ${line}`
    this.logs.push(entry)
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300)
    // 同时输出到进程 stdout/stderr（systemd 下进入 journal）和 DSH logger。
    // DSH 0.1.5 的 ctx.logger 只有内存缓冲、没有输出端，只写 logger 的话 journal 里仍然什么都没有。
    const level = /失败|异常|过期|超时|错误|error/i.test(line) ? 'warn' : 'info'
    let tag = ''
    try { tag = this.logTag?.() ?? '' } catch { /* ignore */ }
    const message = `[dsh-weixin-web] ${tag ? `${tag} ` : ''}${line}`
    try { (this.logSink ?? defaultLogSink)(level, message) } catch { /* 日志失败不影响通道 */ }
    try {
      const fn = this.log?.[level] ?? this.log?.info
      if (typeof fn === 'function' && this.log !== console) fn.call(this.log, message)
    } catch { /* 同上 */ }
  }

  /**
   * 微信驱动的会话不能停在「等待审批」：没有人能在微信里点批准，整轮会永久挂起，
   * 之后该用户的每条消息都只能等到超时（生产环境 9/23 起实际发生）。
   * 每次取到代理时确保会话审批策略为配置值（默认 never：需要审批的操作直接被拒绝，模型继续回复）。
   */
  applyApprovalPolicy(agent) {
    const policy = this.cfg.approvalPolicy ?? 'never'
    const approval = this.ctx.get?.('approval')
    if (!approval || !agent?.session) return
    try {
      if (approval.effectivePolicy?.(agent.session) === policy) return
      approval.setPolicy(agent, policy)
      this.pushLog(`会话 ${agent.id ?? ''} 审批策略设为 ${policy}`)
    } catch (err) {
      this.pushLog(`设置审批策略失败：${err?.message ?? err}`)
    }
  }

  /** 回复超时：取消该会话当前这一轮（含排队输入），避免卡住的轮次让后续消息全部超时。 */
  cancelStuckTurn(agent) {
    try {
      agent?.cancel?.({ kind: 'hook', reason: 'dsh-weixin-web: reply timeout' })
      this.pushLog(`回复超时，已取消会话 ${agent?.id ?? ''} 的当前轮次`)
    } catch (err) {
      this.pushLog(`取消超时轮次失败：${err?.message ?? err}`)
    }
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  async startMonitor() {
    const cred = this.creds
    cred.baseurl = cred.baseurl || ilink.DEFAULT_BASE_URL
    this.status.baseUrl = cred.baseurl
    this.monitorRunning = true
    // 本地捕获 controller：applyCredentials/clearCredentials 会替换 this.monitorAbort，
    // 当前循环必须持有旧引用，abort 旧 controller 才能停下本循环（否则会泄漏/重复轮询）。
    const aborter = this.monitorAbort
    this.pushLog('微信通道启动（iLink 长轮询）')
    try {
      await this.notifyStart({ baseUrl: cred.baseurl, token: cred.bot_token, botAgent: this.botAgent })
    } catch { /* 通知失败不阻塞 */ }

    let failures = 0
    this.status.failures = 0
    this.status.needsRelogin = false
    while (!this.stopped && !aborter.signal.aborted) {
      try {
        const resp = await this.getUpdates({
          baseUrl: cred.baseurl, token: cred.bot_token, buf: this.buf, botAgent: this.botAgent,
          signal: aborter.signal,
        })
        if (this.stopped || aborter.signal.aborted) break
        failures = 0
        this.status.failures = 0
        if (this.status.needsRelogin) this.pushLog('微信会话已恢复')
        this.status.needsRelogin = false
        this.status.lastEventAt = Date.now()
        this.status.lastError = null
        if (typeof resp?.get_updates_buf === 'string' && resp.get_updates_buf) {
          this.buf = resp.get_updates_buf
          this.store.saveBuf(this.buf)
        }
        for (const msg of ilink.normalizeInboundMessages(resp)) {
          if (this.stopped || aborter.signal.aborted) break
          this.enqueueInbound(msg) // 不等待整轮对话：长轮询继续收消息，其它用户不被阻塞
        }
      } catch (err) {
        if (this.stopped || aborter.signal.aborted) break
        if (ilink.isSessionExpired(err)) {
          // bot_token 失效：继续轮询只会立刻再失败。标记需要重新扫码并长时间暂停（重新登录会 abort 本循环）。
          failures = 0
          this.status.failures = 0
          this.status.needsRelogin = true
          this.status.lastError = '微信登录已过期（errcode -14），请在 DSH 侧边栏「微信」中重新扫码登录'
          this.pushLog(`微信会话过期：${err?.message ?? err}，暂停轮询 ${SESSION_EXPIRED_PAUSE_MS / 60_000} 分钟`)
          await this.sleep(SESSION_EXPIRED_PAUSE_MS, aborter.signal)
          continue
        }
        failures += 1
        this.status.failures = failures
        this.status.lastError = err?.message ?? String(err)
        const wait = pollBackoffMs(failures)
        this.pushLog(`长轮询异常（${failures}），${wait / 1000}s 后重试：${err?.message ?? err}`)
        await this.sleep(wait, aborter.signal)
      }
    }
    // 循环退出（停止/登出/重新登录）：只有当前这一轮才置 false，applyCredentials 已启动的新循环不受影响
    if (this.monitorAbort === aborter) this.monitorRunning = false
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    this.monitorAbort.abort()
    this.monitorRunning = false
    if (this.creds?.bot_token) {
      try {
        await ilink.notifyStop({ baseUrl: this.creds.baseurl, token: this.creds.bot_token, botAgent: this.botAgent })
      } catch { /* ignore */ }
    }
    this.pushLog('微信通道已停止')
  }

  /** 登录成功后应用新凭证并重启监视循环（重新扫码同时解除暂停）。 */
  applyCredentials(cred) {
    this.creds = { ...cred, baseurl: cred.baseurl || ilink.DEFAULT_BASE_URL }
    if (this.creds.enabled === false) this.creds.enabled = true
    this.store.saveCredentials(this.creds)
    this.monitorAbort.abort()
    this.monitorAbort = new AbortController()
    this.monitorRunning = false
    this.stopped = false
    this.paused = false
    this.typingTickets.clear()
    this.startMonitor()
  }

  /**
   * 暂停收消息：停掉长轮询并通知 iLink 下线，游标保留。进行中的回复照常发出。
   * 被中断的那次 getupdates 不推进游标，恢复后 iLink 会把暂停期间的消息补发过来。
   */
  async pause() {
    if (this.paused) return
    this.paused = true
    this.monitorAbort.abort()
    this.monitorAbort = new AbortController()
    this.monitorRunning = false
    if (this.creds?.bot_token) {
      try {
        await ilink.notifyStop({ baseUrl: this.creds.baseurl, token: this.creds.bot_token, botAgent: this.botAgent })
      } catch { /* ignore */ }
    }
    this.pushLog('已暂停收消息')
  }

  /** 恢复收消息：从保存的游标继续长轮询。 */
  resume() {
    if (!this.paused) return
    this.paused = false
    this.stopped = false
    if (this.creds?.bot_token) {
      this.pushLog('已恢复收消息')
      this.startMonitor()
    }
  }

  /** 解绑时彻底释放：停轮询、通知下线、摘掉事件监听。 */
  async dispose() {
    await this.stop()
    for (const d of this.disposers ?? []) {
      try { if (typeof d === 'function') d() } catch { /* ignore */ }
    }
    this.disposers = []
  }

  /** 登出：清凭证 + 下线通知 + 停监视。 */
  async clearCredentials() {
    if (this.creds?.bot_token) {
      try {
        await ilink.notifyStop({ baseUrl: this.creds.baseurl, token: this.creds.bot_token, botAgent: this.botAgent })
      } catch { /* ignore */ }
    }
    this.monitorAbort.abort()
    this.monitorAbort = new AbortController()
    this.monitorRunning = false
    this.stopped = true
    this.creds = null
    this.store.saveCredentials(null)
    this.pushLog('已登出')
  }

  /* ------------------------------ 会话/代理 ------------------------------ */

  /** 本机器人的个性化设置（人设/模型/预设），见 settings.mts。 */
  botSettings() {
    return normalizeSettings(this.creds?.settings)
  }

  /** 本机器人指定的模型（未指定返回 null = 跟随 DSH 默认）。 */
  botModel() {
    return this.botSettings().model
  }

  /**
   * 组装微信会话的 agent setup。
   * @param presetId 要装配的 DSH 预设：新会话传机器人设置的预设，恢复会话传会话创建时的预设；
   *                 undefined = DSH 默认预设（与旧版行为一致）。
   */
  async composeSetup(presetId) {
    const presets = this.ctx.get('agentPresets')
    return async (agentCtx) => {
      // 通道指令：注册到 agent 作用域，只约束本微信会话、不污染网页端。
      // 关键：禁止 ask_user_question（它走网页 provider，微信端无法应答会卡住整轮）。
      try {
        agentCtx.systemPrompt.section({
          name: 'weixin:channel-instruction',
          order: 50,
          text: '你当前通过微信消息通道与用户交流，交流是异步、回合式的文字对话。'
            + '不要使用 ask_user_question 工具——它会在网页端阻塞等待回答，微信端无法响应会导致整轮卡住。'
            + '信息不足时：优先在回复正文里直接向用户反问，或采用合理默认值并简要说明你的假设。'
            + '用户发来的文件、视频会作为附件（只读路径）出现在消息里，需要时用文件工具读取；语音已由微信转成文字。'
            + '需要把文件、图片或视频发给用户时，先把文件写到工作目录，再调用 send_weixin_file 工具（不能发语音）。',
        })
        // 机器人人设：每次组装提示时读取最新设置（抽屉里改了下一轮就生效）；无人设时为空段，宿主会跳过。
        // interpolate:false：人设是用户自由文本，里面的 {{...}} 不当模板变量。
        agentCtx.systemPrompt.section({
          name: 'weixin:persona',
          order: 49,
          interpolate: false,
          text: () => personaPromptText(this.botSettings().persona),
        })
      } catch (err) {
        this.pushLog(`注入通道指令失败：${err?.message ?? err}`)
      }
      this.installModelOverride(agentCtx)
      if (!presets) return
      try {
        const resolved = await presets.resolve(presetId)
        if (resolved?.id) await presets.mount(agentCtx, resolved.id)
      } catch (err) {
        if (presetId === undefined) {
          this.pushLog(`agentPresets 装配失败（用默认）：${err?.message ?? err}`)
          return
        }
        this.pushLog(`预设「${presetId}」装配失败，改用 DSH 默认预设：${err?.message ?? err}`)
        try {
          const fallback = await presets.resolve(undefined)
          if (fallback?.id) await presets.mount(agentCtx, fallback.id)
        } catch (err2) {
          this.pushLog(`agentPresets 装配失败（用默认）：${err2?.message ?? err2}`)
        }
      }
    }
  }

  /**
   * 机器人模型覆盖会话模型：在 agent/request 瀑布最外层（prepend）改写 provider/model，
   * 这样即使有人在网页端给这个会话选了别的模型，微信会话仍用机器人设置的模型。
   * 同时改写提示模板变量 {{provider}}/{{model}}，让人设里的模型名与实际一致。
   * 每次请求时读取最新设置：抽屉里改了模型，下一次请求即生效，无需重开会话。
   */
  installModelOverride(agentCtx) {
    if (typeof agentCtx?.on !== 'function') return
    try {
      agentCtx.on('agent/request', async (_payload, next) => overrideRequestModel(await next(), this.botModel()), { prepend: true })
      agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembled = await next()
        const model = this.botModel()
        if (!model || !assembled || typeof assembled !== 'object') return assembled
        return { ...assembled, variables: { ...assembled.variables, provider: model.provider, model: model.model } }
      }, { prepend: true })
    } catch (err) {
      this.pushLog(`安装机器人模型覆盖失败：${err?.message ?? err}`)
    }
  }

  /** 新会话的 AgentOptions：机器人指定了模型就用它，否则 DSH 默认模型。 */
  resolveAgentOptions() {
    const model = this.botModel()
    return model ? { ...model } : this.resolveDefaultAgentOptions()
  }

  /**
   * 新会话使用的预设 id：机器人设置的预设（无效/损坏时退回默认并记日志）；未设置返回 undefined（DSH 默认）。
   */
  async resolveNewSessionPreset() {
    const wanted = this.botSettings().preset
    if (!wanted) return undefined
    const presets = this.ctx.get?.('agentPresets')
    if (!presets) return undefined
    try {
      const resolved = await presets.resolve(wanted)
      if (resolved?.broken) throw new Error(String(resolved.broken).split('\n')[0])
      return resolved?.id ?? undefined
    } catch (err) {
      this.pushLog(`机器人预设「${wanted}」不可用，新会话改用 DSH 默认预设：${err?.message ?? err}`)
      return undefined
    }
  }

  /**
   * 已有会话创建时固定的预设（DSH 会话投影 agentPreset）。恢复会话必须装配同一个预设；
   * 查不到（老会话没记录 / 宿主不支持）返回 undefined，即按 DSH 默认（与旧版一致）。
   */
  async storedPresetFor(sessionId) {
    const query = this.ctx.get?.('sessionQuery')
    if (typeof query?.observeSession !== 'function') return undefined
    let observation
    try {
      observation = await query.observeSession(sessionId)
      const preset = observation?.projections?.values?.agentPreset
      return typeof preset === 'string' && preset ? preset : undefined
    } catch {
      return undefined
    } finally {
      try { observation?.[Symbol.dispose]?.() } catch { /* ignore */ }
    }
  }

  /** 解析当前默认模型为 AgentOptions（provider + model）。harness 的人设里含 {{model}}/{{provider}} 模板变量，
   *  只有 agent.options 里显式给了模型才渲染得出来，否则首条消息就报「prompt variable has no value」。 */
  resolveDefaultAgentOptions() {
    try {
      const sel = this.ctx.get('agentDefaultModel')?.currentSelection?.()
      if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model }
    } catch (err) {
      this.pushLog(`解析默认模型失败：${err?.message ?? err}`)
    }
    return {}
  }

  /**
   * 会话是否已在 DSH 界面里被归档。DSH 0.2 的 archived-session-gate 会直接拒绝归档会话的每一步
   * （turn/end reason=blocked），微信消息永远等不到回复、只会在 replyTimeoutMs 后回「处理超时」；
   * 0.1.5 虽不拦截，但归档本身就表示「这段对话已结束」。因此归档会话不再复用，改为新建。
   * workspaceRegistry 不在 inject 里（老版本插件清单不变），取不到或出错时按未归档处理。
   */
  isSessionArchived(sessionId) {
    try {
      const ids = this.ctx.get?.('workspaceRegistry')?.archivedSessionIds
      return Array.isArray(ids) && ids.includes(sessionId)
    } catch {
      return false
    }
  }

  /** 当前机器人显示名：绑定时起的名字，否则「微信机器人 {ilink_bot_id 末 4 位}」。 */
  botName() {
    return this.creds?.name || defaultBotName(this.creds?.ilink_bot_id)
  }

  /** 该微信用户会话的标题：微信·{机器人名}（多个对话方时加对方尾号）。 */
  titleFor(userId) {
    return weixinSessionTitle(this.botName(), userId, Object.keys(this.sessionMap).length > 1)
  }

  /**
   * 入站消息的 source。DSH 0.2 的聊天界面只把 kind:'user' 渲染成普通用户气泡，其它来源（包括之前的
   * plugin:dsh-weixin-web）一律折叠成「收到执行请求」卡片。微信消息本来就是真人发的，用 kind:'user'，
   * 附加字段只做归因（宿主保留未知字段，网页端自己的消息也带 rpcId 等字段），不进入模型可见内容。
   * 注意：v4 会话格式拒绝旧的 { kind: 'plugin', plugin } 写法。
   */
  messageSource(from) {
    const source: any = { kind: 'user', channel: 'dsh-weixin-web', peer: from }
    if (this.creds?.ilink_bot_id) source.bot = this.creds.ilink_bot_id
    return source
  }

  /** 会话呈现：归入「微信」工作区 + 钉住标题。失败只记日志。wait 仅启动对账时使用。 */
  async decorateSession(agent, userId, wait?) {
    if (!agent?.id) return
    try {
      await this.workspace.attach(agent.id, wait)
      await applySessionTitle(this.ctx, agent.session, this.titleFor(userId), (line) => this.pushLog(line), wait)
    } catch (err) {
      this.pushLog(`整理会话 ${agent.id} 失败：${err?.message ?? err}`)
    }
  }

  /** 按当前机器人名/对话方数量刷新所有在内存中的会话标题（改名、出现第二个对话方时调用）。 */
  async refreshTitles(wait?) {
    for (const [userId, sessionId] of Object.entries(this.sessionMap)) {
      const agent = this.ctx.agents?.get?.(sessionId)
      if (agent) await applySessionTitle(this.ctx, agent.session, this.titleFor(userId), (line) => this.pushLog(line), wait)
    }
  }

  /**
   * 启动对账：确保「微信」工作区存在且排第一，把已映射的会话（未归档）恢复、归组并设置标题。
   * 不新建会话（已归档的会话等下一条消息再新建）。等待宿主服务就绪，最多 waitMs。
   */
  /**
   * 打开已映射的会话。内存里已有代理就直接用；否则 resume。
   * 启动时 DSH 自己也会打开浏览器正在看的会话，两边抢同一把写句柄，后到的 resume 抛
   * 「already owned by an active write handle」。这时不能放弃、更不能新建会话：
   * 等占用方把代理注册出来（或句柄释放后重试 resume），最多 WRITER_HELD_ATTEMPTS 次。
   */
  async openMappedSession(sessionId) {
    const attempts = this.writerHeldAttempts ?? WRITER_HELD_ATTEMPTS
    const gap = this.writerHeldGapMs ?? WRITER_HELD_GAP_MS
    let heldLogged = false
    let lastErr
    for (let i = 0; i < attempts; i++) {
      const live = this.ctx.agents?.get?.(sessionId)
      if (live) return live
      try {
        const resumed = await this.ctx.agents.resume({
          resumeSessionId: sessionId, agentOptions: this.resolveAgentOptions(), setup: await this.composeSetup(await this.storedPresetFor(sessionId)),
        })
        if (resumed?.error) throw resumed.error
        if (!resumed?.agent) throw new Error(`恢复会话 ${sessionId} 没有返回代理`)
        return resumed.agent
      } catch (err) {
        lastErr = err
        if (!isWriterHeldError(err) || i === attempts - 1) throw err
        if (!heldLogged) {
          heldLogged = true
          this.pushLog(`会话 ${sessionId} 的写句柄正被占用，等待已有会话就绪后再用，不新建`)
        }
        await this.sleep(gap)
      }
    }
    throw lastErr
  }

  async reconcile({ waitMs = 60_000 } = {}) {
    const wait = { timeoutMs: waitMs }
    await this.workspace.ensure(wait)
    for (const [userId, sessionId] of Object.entries(this.sessionMap)) {
      if (this.stopped && !this.creds) break
      if (this.isSessionArchived(sessionId)) continue
      try {
        const agent = await this.openMappedSession(sessionId)
        this.applyApprovalPolicy(agent)
        this.seedActivityFromSession(userId, agent)
        await this.decorateSession(agent, userId, wait)
      } catch (err) {
        this.pushLog(`启动对账：会话 ${sessionId} 处理失败：${err?.message ?? err}`)
      }
    }
  }

  /** 微信用户 → 会话/代理。已有则复用；持久化会话则恢复（已归档的除外）；否则新建。 */
  async ensureAgentFor(userId) {
    let sessionId = this.sessionMap[userId]
    if (sessionId && this.isSessionArchived(sessionId)) {
      this.pushLog(`会话 ${sessionId} 已在 DSH 中归档，为 ${userId.slice(0, 12)}… 新建会话`)
      sessionId = undefined
    }
    if (sessionId) {
      try {
        const wasLive = !!this.ctx.agents?.get?.(sessionId)
        const agent = await this.openMappedSession(sessionId)
        if (!wasLive) this.pushLog(`使用已有会话 ${sessionId}（${userId.slice(0, 12)}…）`)
        this.applyApprovalPolicy(agent)
        await this.decorateSession(agent, userId)
        return agent
      } catch (err) {
        if (isWriterHeldError(err)) {
          this.pushLog(`恢复会话 ${sessionId} 失败：写句柄一直被占用，不新建会话`)
          throw err
        }
        this.pushLog(`恢复会话 ${sessionId} 失败：${err?.message ?? err}，将新建`)
      }
    }

    const newId = `session-${randomUUID()}`
    try {
      const presetId = await this.resolveNewSessionPreset()
      const { agent } = await this.ctx.agents.create({
        sessionId: newId,
        agentOptions: this.resolveAgentOptions(),
        meta: { cwd: this.cfg.cwd, ...(presetId ? { agentPreset: presetId } : {}) },
        setup: await this.composeSetup(presetId),
      })
      this.sessionMap[userId] = newId
      this.store.saveSessionMap(this.sessionMap)
      this.pushLog(`为 ${userId.slice(0, 12)}… 新建会话 ${newId}`)
      this.applyApprovalPolicy(agent)
      // 归组 + 钉住标题必须在第一条消息（followup）之前，否则宿主会先按首条消息自动生成标题
      await this.decorateSession(agent, userId)
      // 第二个对话方出现：已有会话的标题也要补上对方尾号，才能区分
      if (Object.keys(this.sessionMap).length === 2) await this.refreshTitles()
      return agent
    } catch (err) {
      this.pushLog(`新建会话失败：${err?.message ?? err}`)
      throw err
    }
  }

  /**
   * 开始新对话：该微信用户之后的消息进入一个全新的会话（用当前机器人设置的预设/模型/人设）。
   * 旧会话保留在「微信」工作区，标题加「旧对话」后缀；正在回复中时拒绝，避免回复落到错的会话。
   * @returns {{ oldSessionId: string|null, sessionId: string }}
   */
  async startNewChat(userId) {
    const peer = String(userId ?? '').trim()
    if (!peer) throw new Error('缺少联系人')
    if (!(peer in this.sessionMap)) throw new Error('这个机器人还没有和该联系人的对话')
    const busy = [...this.pending.values()].some((p) => p.from === peer) || this.inboundQueues.has(peer)
    if (busy) throw new Error('正在回复这个联系人，等这一轮结束后再开始新对话')
    const oldSessionId = this.sessionMap[peer]
    const oldTitle = this.titleFor(peer)
    delete this.sessionMap[peer]
    this.store.saveSessionMap(this.sessionMap)
    const oldAgent = oldSessionId ? this.ctx.agents?.get?.(oldSessionId) : undefined
    if (oldAgent?.session) {
      const d = new Date()
      await applySessionTitle(this.ctx, oldAgent.session, `${oldTitle}·旧对话 ${d.getMonth() + 1}/${d.getDate()}`, (line) => this.pushLog(line))
    }
    let agent
    try {
      agent = await this.ensureAgentFor(peer)
    } catch (err) {
      // 新建失败：恢复旧映射，避免联系人从列表里消失
      if (oldSessionId && !this.sessionMap[peer]) {
        this.sessionMap[peer] = oldSessionId
        this.store.saveSessionMap(this.sessionMap)
      }
      throw err
    }
    this.pushLog(`为 ${peer.slice(0, 12)}… 开始新对话 ${agent.id}（旧会话 ${oldSessionId ?? '无'} 保留）`)
    return { oldSessionId: oldSessionId ?? null, sessionId: agent.id }
  }

  /* ------------------------------ 入站处理 ------------------------------ */

  /**
   * 入站消息排队：同一微信用户串行处理（保证回复顺序、同一会话一次一轮），不同用户互不阻塞。
   * 长轮询循环不再 await 整轮对话（以前一轮最长 replyTimeoutMs=15 分钟，期间所有人的消息都收不到）。
   * @returns {Promise<void>} 本条消息处理完成（测试用；永不 reject）
   */
  enqueueInbound(msg) {
    const key = msg?.from || '(unknown)'
    // 收到即记录最新 context_token：上一轮还在跑时，回复也能用新 token（旧 token 可能已过期）
    if (msg?.from && msg?.contextToken) this.contextTokens.set(msg.from, msg.contextToken)
    const prev = this.inboundQueues.get(key) ?? Promise.resolve()
    const run = prev.then(() => this.handleInbound(msg)).catch((err) => {
      this.pushLog(`处理消息异常：${err?.message ?? err}`)
    })
    this.inboundQueues.set(key, run)
    run.then(() => { if (this.inboundQueues.get(key) === run) this.inboundQueues.delete(key) })
    return run
  }

  async handleInbound(msg) {
    const { from, to, contextToken } = msg
    if (!to?.endsWith('@im.bot')) return

    const images: any[] = Array.isArray(msg.images) ? [...msg.images] : (msg.image ? [msg.image] : [])
    const files: any[] = Array.isArray(msg.files) ? [...msg.files] : []
    const videos: any[] = Array.isArray(msg.videos) ? [...msg.videos] : []
    const voices: any[] = Array.isArray(msg.voices) ? msg.voices : []
    const quote = msg.quote ?? null
    // 引用了图片/文件/视频且本条自身没带媒体：把被引用的媒体一并交给模型（与官方插件一致）
    let quotedMedia = null
    if (quote?.media && !images.length && !files.length && !videos.length) {
      quotedMedia = quote.media
      if (quote.media.kind === 'image') images.push(quote.media)
      else if (quote.media.kind === 'file') files.push(quote.media)
      else if (quote.media.kind === 'video') videos.push(quote.media)
    }

    // 正文：文本 + 语音转写（腾讯服务端已 ASR，无需本地识别）
    const ownText = [msg.text, msg.voiceText].map((t) => String(t ?? '').trim()).filter(Boolean).join('\n')
    const quoteLine = quote?.text ? `> 引用：${quote.text.replace(/\s+/g, ' ').slice(0, 300)}` : ''
    const bodyText = ownText && quoteLine ? `${quoteLine}\n\n${ownText}` : ownText
    const hasMedia = images.length > 0 || files.length > 0 || videos.length > 0
    const label = this.inboundLabel({ images, files, videos, voices, quotedMedia })

    if (!ownText && !hasMedia) {
      if (voices.length > 0) {
        // 语音但微信没给转写文字（或转写为空）：不跑模型，直接请用户重说/打字
        this.pushLog(`收：${from.slice(0, 12)}… [语音，无转写]`)
        this.noteActivity(from, 'inbound', '[语音]')
        await this.sendReply(from, contextToken, '没听清这段语音（微信没有给出转写文字）🙏 可以再说一遍，或者直接打字发给我')
        return
      }
      await this.sendReply(from, contextToken, '这个格式暂不支持（目前支持文字 / 图片 / 语音 / 文件 / 视频）🙏')
      return
    }
    const preview = [ownText, label].filter(Boolean).join(' ')
    this.pushLog(`收：${from.slice(0, 12)}… ${preview.slice(0, 60)}`)
    this.noteActivity(from, 'inbound', preview)

    // 正在输入提示；发送失败视为 ticket 可能已失效，清缓存下次重建（review S12）
    const ticket = await this.getTypingTicket(from, contextToken)
    if (ticket) {
      await ilink.sendTyping({ baseUrl: this.creds.baseurl, token: this.creds.bot_token, to: from, typingTicket: ticket, status: 1, botAgent: this.botAgent })
        .catch(() => { this.typingTickets.delete(from) })
    }

    let agent
    try {
      agent = await this.ensureAgentFor(from)
    } catch (err) {
      await this.sendReply(from, contextToken, `😵 会话准备失败：${err?.message ?? err}`)
      return
    }

    // 图片：仅在模型确实支持视觉时注入 image 块。否则图片块会持久化进会话历史，
    // 导致后续每一轮都把图片重发给纯文本模型 → 每次都报错 → 整段会话「发什么都没反应」。
    const needVision = images.length > 0 || videos.some((v) => v.thumb)
    const vision = needVision ? await this.supportsVision(agent) : false
    if (images.length > 0 && !vision && !ownText && !files.length && !videos.length) {
      // 纯图片 + 模型不看图：不注入、不跑模型，直接友好提示，避免污染历史
      this.stopTypingOnce({ from, typingStopped: false })
      await this.sendReply(from, contextToken, '收到你的图片了，但当前模型是纯文本模型，不支持看图 🙏（可发文字描述，或在微信抽屉里给这个机器人换一个「可看图」的模型）')
      return
    }

    const media: any[] = []
    const notes: string[] = []
    const stamp = Date.now()
    for (const [i, image] of images.entries()) {
      if (vision) {
        if (this.ctx.attachments) media.push(await this.resolveImageBlock(image))
      } else {
        // 有文字 + 模型不看图：图片按文件附件交给模型（只给路径，不进视觉通道）
        const block = await this.resolveFileBlock(image, `weixin-image-${stamp}${images.length > 1 ? `-${i + 1}` : ''}`, '图片')
        if (block.type === 'file') notes.push(`图片已作为文件附件保存（当前模型不看图）：${block.attachment?.name ?? ''}`)
        media.push(block)
      }
    }
    for (const file of files) media.push(await this.resolveFileBlock(file, file.name || 'weixin-file', '文件'))
    for (const [i, video] of videos.entries()) {
      media.push(await this.resolveFileBlock(video, `weixin-video-${stamp}${videos.length > 1 ? `-${i + 1}` : ''}.mp4`, '视频'))
      if (vision && video.thumb && this.ctx.attachments) {
        const thumb = await this.resolveImageBlock(video.thumb)
        if (thumb.type === 'image') media.push(thumb) // 封面失败就算了，不额外报错
      }
    }

    // 只有媒体没有文字时，给模型一句说明（否则它只看到附件不知道用户要干什么）
    const headline = ownText ? bodyText : [quoteLine, `（用户通过微信发来了${label}${quotedMedia ? '（引用的消息里的）' : ''}，没有附带文字）`].filter(Boolean).join('\n\n')
    const content: any[] = []
    if (headline) content.push({ type: 'text', text: notes.length ? `${headline}\n\n${notes.join('\n')}` : headline })
    content.push(...media)

    const userMessage = makeUserMessage({
      content,
      source: this.messageSource(from),
    })

    await new Promise<void>((resolve) => {
      const pend: any = { from, contextToken, sessionId: agent.id, resolve, timer: null, typingStopped: false }
      const timer = setTimeout(() => {
        this.pending.delete(userMessage.id)
        this.cancelStuckTurn(agent)
        this.stopTypingOnce(pend)
        this.sendReply(from, contextToken, '⏰ 处理超时，请稍后再试').finally(resolve)
      }, this.cfg.replyTimeoutMs)
      pend.timer = timer
      this.pending.set(userMessage.id, pend)
      try {
        agent.followup(userMessage)
      } catch (err) {
        // followup 同步抛错（如代理已销毁）：清理 pending/timer 并回错误，避免挂起直到超时
        clearTimeout(timer)
        this.pending.delete(userMessage.id)
        this.pushLog(`followup 失败：${err?.message ?? err}`)
        this.stopTypingOnce(pend) // 同步失败也要取消「正在输入」，否则指示会一直挂着
        this.sendReply(from, contextToken, `😵 处理失败：${err?.message ?? err}`).finally(resolve)
      }
    })
  }

  /**
   * 会话实际使用的模型：机器人指定的模型 > 会话最近一次请求记录的模型 > 代理创建参数 > DSH 默认。
   * 参数可以是代理（有 session）或旧式 AgentOptions 对象。
   */
  effectiveModel(agentOrOptions) {
    const bot = this.botModel()
    if (bot) return bot
    try {
      const logged = agentOrOptions?.session?.requestHeader?.()?.config
      if (logged?.provider && logged?.model) return { provider: logged.provider, model: logged.model }
    } catch { /* 宿主不支持就看下一个 */ }
    const opts = agentOrOptions?.session ? agentOrOptions.options : agentOrOptions
    let sel: any = {}
    try { sel = this.ctx.get?.('agentDefaultModel')?.currentSelection?.() ?? {} } catch { sel = {} }
    const provider = opts?.provider || sel.provider
    const model = opts?.model || sel.model
    return provider && model ? { provider, model } : null
  }

  /**
   * 判断会话所用模型是否支持图片输入（保守：无法判断/查不到一律视为不支持）。
   * 结果按 `provider:model` 缓存，避免每张图都请求模型元数据。
   */
  async supportsVision(agentOrOptions) {
    try {
      const llm = this.ctx.get?.('llm')
      if (!llm) return false
      const m = this.effectiveModel(agentOrOptions)
      if (!m) return false
      const key = `${m.provider}:${m.model}`
      if (this.visionCache.has(key)) return this.visionCache.get(key)
      const info = await llm.resolveModelInfo(m.provider, m.model)
      const ok = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
      this.visionCache.set(key, ok)
      return ok
    } catch {
      return false
    }
  }

  /** 单个媒体大小上限（字节）。 */
  maxMediaBytes() {
    const n = Number(this.cfg.maxMediaBytes)
    return Number.isFinite(n) && n > 0 ? n : ilink.DEFAULT_MAX_MEDIA_BYTES
  }

  /** 下载解密一个媒体（图片/文件/视频）。配置了 cdnBaseUrl 时只走它（彩排/测试不碰真实 CDN）。 */
  fetchMedia(ref, maxBytes = this.maxMediaBytes()) {
    return this.downloadImageBytes({
      encryptQueryParam: ref.encrypt_query_param,
      fullUrl: ref.full_url,
      aesKey: ref.aesKey,
      cdnBaseUrl: this.cfg.cdnBaseUrl || ilink.CDN_BASE_URL,
      forceBase: !!this.cfg.cdnBaseUrl,
      maxBytes,
      timeoutMs: ilink.MEDIA_TIMEOUT_MS,
    })
  }

  /** 入站媒体的简短描述：[图片×2] [文件] a.pdf [视频] [语音]。 */
  inboundLabel({ images = [], files = [], videos = [], voices = [], quotedMedia = null }: any) {
    const parts: string[] = []
    if (images.length) parts.push(images.length > 1 ? `[图片×${images.length}]` : '[图片]')
    for (const f of files) parts.push(`[文件] ${f.name || ''}`.trim())
    if (videos.length) parts.push(videos.length > 1 ? `[视频×${videos.length}]` : '[视频]')
    if (voices.length && !voices.some((v) => v.text)) parts.push('[语音]')
    if (quotedMedia && !parts.length) parts.push('[引用]')
    return parts.join(' ')
  }

  /** 把微信图片下载解密后存成 Harness 图片附件，返回 image 内容块；失败/超限降级为文本块。 */
  async resolveImageBlock(image) {
    const limits = this.ctx.attachments?.imageLimits
    const maxBytes = limits?.maxImageBytes ?? 0
    try {
      const bytes = await this.fetchMedia(image, Math.min(...[maxBytes, this.maxMediaBytes()].filter((n) => n > 0)))
      const attachment = await this.ctx.attachments.saveImage({
        data: bytes, // Buffer 即 Uint8Array
        mediaType: ilink.sniffImageMime(bytes),
      })
      return { type: 'image', attachment }
    } catch (err) {
      if (err instanceof ilink.MediaTooLargeError) {
        this.pushLog(`图片超限 ${err.bytes ?? '?'}B > ${err.maxBytes}B，略过图片理解`)
        return { type: 'text', text: '[图片过大，未处理]' }
      }
      this.pushLog(`图片下载/解密/入库失败：${err?.message ?? err}`)
      return { type: 'text', text: '[图片处理失败]' }
    }
  }

  /**
   * 把微信文件/视频（或不看图模型下的图片）下载解密后存成 Harness 文件附件，返回 file 内容块
   * （宿主会把它投影成带只读路径的文本，模型可用文件工具读取）。超限/失败降级为文本块。
   */
  async resolveFileBlock(ref, name, kindLabel = '文件') {
    const max = this.maxMediaBytes()
    const mb = Math.round(max / 1024 / 1024)
    const shown = name ? `「${name}」` : ''
    if (ref.size && ref.size > max + 16) {
      this.pushLog(`${kindLabel}${shown}超过 ${mb}MB（${ref.size}B），未下载`)
      return { type: 'text', text: `[${kindLabel}${shown}超过 ${mb}MB，未接收]` }
    }
    if (!this.ctx.attachments?.saveFile) {
      return { type: 'text', text: `[${kindLabel}${shown}无法保存：DSH 附件服务不可用]` }
    }
    try {
      const bytes = await this.fetchMedia(ref, max)
      // 图片按实际格式补扩展名（微信图片多为 JPEG，也可能是 PNG/GIF/WEBP）
      const finalName = kindLabel === '图片' && !/\.[a-z0-9]{2,5}$/i.test(name)
        ? `${name}.${ilink.sniffImageMime(bytes).split('/')[1].replace('jpeg', 'jpg')}`
        : name
      const attachment = await this.ctx.attachments.saveFile({ data: bytes, name: finalName })
      return { type: 'file', attachment }
    } catch (err) {
      if (err instanceof ilink.MediaTooLargeError) {
        this.pushLog(`${kindLabel}${shown}超过 ${mb}MB，已放弃`)
        return { type: 'text', text: `[${kindLabel}${shown}超过 ${mb}MB，未接收]` }
      }
      this.pushLog(`${kindLabel}${shown}下载/解密/入库失败：${err?.message ?? err}`)
      return { type: 'text', text: `[${kindLabel}${shown}接收失败]` }
    }
  }

  /** 取消「正在输入」指示（status=2），失败静默（review S12）。 */
  stopTyping(userId) {
    const ticket = this.typingTickets.get(userId)
    if (!this.creds?.bot_token || !ticket) return
    ilink.sendTyping({ baseUrl: this.creds.baseurl, token: this.creds.bot_token, to: userId, typingTicket: ticket, status: 2, botAgent: this.botAgent })
      .catch(() => {})
  }

  /** 幂等取消：同一轮只停一次「正在输入」，超时/同步失败/turn-end 多路共用，避免重复 status=2。 */
  stopTypingOnce(pend) {
    if (!pend || pend.typingStopped) return
    pend.typingStopped = true
    this.stopTyping(pend.from)
  }

  async getTypingTicket(userId, contextToken) {
    if (this.typingTickets.has(userId)) return this.typingTickets.get(userId)
    try {
      const resp = await ilink.getConfig({
        baseUrl: this.creds.baseurl, token: this.creds.bot_token,
        ilinkUserId: userId, contextToken, botAgent: this.botAgent,
      })
      const t = resp?.typing_ticket ?? ''
      this.typingTickets.set(userId, t)
      return t
    } catch {
      return ''
    }
  }

  /* ------------------------------ 事件→回复 ------------------------------ */

  /** 本会话中仍在等待 user/message 的 pending（尚未被某一轮认领）。 */
  unclaimedPending(sessionId) {
    const out: Array<[any, any]> = []
    for (const [msgId, pend] of this.pending) {
      if (pend.sessionId === sessionId && !pend.claimed) out.push([msgId, pend])
    }
    return out
  }

  handleSessionEvent(session, event) {
    const sessionId = session.id
    switch (event.type) {
      case 'turn/start': {
        const turn = event.data?.turn
        this.turns.set(sessionId, turn)
        // followup 之后开始的第一轮就是处理这条消息的候选轮次：若该轮在 user/message 之前就出错
        // （如 prepareRequest 失败、模型未配置），用它把错误立即回给用户，而不是干等 15 分钟超时。
        for (const [, pend] of this.unclaimedPending(sessionId)) {
          if (pend.candidateTurn === undefined) pend.candidateTurn = turn
        }
        break
      }
      case 'user/message': {
        const msgId = event.data?.id
        const pend = this.pending.get(msgId)
        if (pend && pend.sessionId === sessionId) {
          pend.claimed = true
          const turn = event.data?.turn ?? this.turns.get(sessionId)
          this.collectors.set(sessionId, { sessionId, turn, msgId, parts: [], pending: pend })
        }
        break
      }
      case 'assistant/message': {
        const c = this.collectors.get(sessionId)
        if (!c || event.data?.turn !== c.turn) break
        const blocks = event.data?.message?.content ?? []
        const texts = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text)
        if (texts.length) {
          if (this.cfg.replyMode === 'last') c.parts.length = 0
          c.parts.push(texts.join('\n'))
        }
        break
      }
      case 'turn/end': {
        const c = this.collectors.get(sessionId)
        if (!c || event.data?.turn !== c.turn) {
          this.settleUnclaimed(sessionId, event)
          break
        }
        this.collectors.delete(sessionId)
        const { pending, parts, msgId } = c
        // 已超时：pending 已被超时分支移除，说明「处理超时」已发出，勿重复发送完整回复（review I1）
        if (!this.pending.has(msgId)) {
          if (pending.timer) clearTimeout(pending.timer)
          this.stopTypingOnce(pending)
          pending.resolve()
          break
        }
        this.pending.delete(msgId)
        if (pending.timer) clearTimeout(pending.timer)
        const reply = parts.join('\n').trim()
        // 模型报错且无任何助手文本（如「模型不支持图片输入」）时，不再静默吞掉：
        // 给用户一个明确提示，避免像「图片发过去没反应」这种悬空体验。
        const outText = reply || this.turnErrorText(event)
        const send = outText
          ? this.sendReply(pending.from, pending.contextToken, outText)
          : Promise.resolve()
        send.finally(() => {
          this.stopTypingOnce(pending) // 轮次结束取消输入指示（review S12）
          pending.resolve()
        })
        break
      }
      default:
        break
    }
  }

  /** turn/end 原因为 error 时给用户的提示；非错误返回空串。 */
  turnErrorText(event) {
    if (event.data?.reason?.kind !== 'error') return ''
    const emsg = event.data.reason.error?.message ?? ''
    const ecode = event.data.reason.error?.code ?? ''
    return /image|UNSUPPORTED_CONTENT/i.test(`${emsg} ${ecode}`)
      ? '收到你的图片了，但当前模型是纯文本模型，不支持看图 🙏（可发文字描述）'
      : `😵 处理失败：${emsg || '未知错误'}`
  }

  /**
   * 某一轮结束时仍未出现我们的 user/message：
   * - 该轮出错 → 消息已被这一轮取走但没能进入历史，立即回错误并结束等待；
   * - 其它原因（空轮次、被拦截、被取消）→ 清除候选，等下一轮再认领（仍有超时兜底）。
   */
  settleUnclaimed(sessionId, event) {
    const turn = event.data?.turn
    for (const [msgId, pend] of this.unclaimedPending(sessionId)) {
      if (pend.candidateTurn !== turn) continue
      const errText = this.turnErrorText(event)
      if (!errText) { pend.candidateTurn = undefined; continue }
      this.pending.delete(msgId)
      if (pend.timer) clearTimeout(pend.timer)
      this.pushLog(`第 ${turn} 轮在处理消息前失败：${event.data?.reason?.error?.message ?? ''}`)
      this.sendReply(pend.from, pend.contextToken, errText).finally(() => {
        this.stopTypingOnce(pend)
        pend.resolve()
      })
    }
  }

  /* ------------------------------ 发送 ------------------------------ */

  /** 调速排队：并发发送也按队列串行预约时间片，保证任意两次发送间隔 ≥ sendIntervalMs（review S6）。 */
  async paceSend() {
    const slot = this.sendQueue.then(async () => {
      const wait = this.lastSendAt + this.cfg.sendIntervalMs - Date.now()
      if (wait > 0) await sleep(wait)
      this.lastSendAt = Date.now()
    })
    this.sendQueue = slot.catch(() => {}) // 单次失败不断链
    return slot
  }

  /**
   * 发送回复。context_token 优先用该用户最近一次入站带来的（长对话期间旧 token 可能过期），
   * 传入的 contextToken 只作兜底。iLink 拒绝时（非 bot 登录过期）换最新 token / 去掉 token 重试一次。
   * 最终失败会写日志并记录到 status.lastSendError，面板可见。
   * @returns {Promise<boolean>} 是否全部分块发送成功（review S5）。
   */
  async sendReply(to, contextToken, text) {
    let token = this.contextTokens.get(to) ?? contextToken
    try {
      for (const piece of chunkText(text, this.cfg.maxChunk)) {
        await this.paceSend() // 每个分块发送前都调速（review I2）
        try {
          await this.sendChunk(to, token, piece)
        } catch (err) {
          if (!(err instanceof ilink.ILinkError) || !token || err.errcode === -14) throw err
          const fresher = this.contextTokens.get(to)
          const retryToken = fresher && fresher !== token ? fresher : undefined
          this.pushLog(`发送被拒（${err.message}），${retryToken ? '换用最新 context_token' : '不带 context_token'} 重试一次`)
          await this.paceSend()
          await this.sendChunk(to, retryToken, piece)
          token = retryToken
        }
      }
      if (this.status.lastSendError?.to === to) this.status.lastSendError = null
      this.pushLog(`发：${to.slice(0, 12)}… ${text.slice(0, 60)}`)
      this.noteActivity(to, 'outbound', text)
      return true
    } catch (err) {
      const expired = err?.errcode === -14
      const message = expired ? '微信登录已过期（errcode -14），请重新扫码登录' : (err?.message ?? String(err))
      this.status.lastSendError = { at: Date.now(), to, message }
      this.pushLog(`发送失败（${to.slice(0, 12)}…）：${message}`)
      return false
    }
  }

  /** 发送单个分块；独立成方法便于测试打桩计时。 */
  async sendChunk(to, contextToken, piece) {
    await ilink.sendMessage({
      baseUrl: this.creds.baseurl, token: this.creds.bot_token,
      to, text: piece, contextToken, botAgent: this.botAgent,
      onWarn: (w) => this.pushLog(`发送 ${w}`),
    })
  }

  /** 发送单个媒体条目；独立成方法便于测试打桩。 */
  async sendItem(to, contextToken, item) {
    await ilink.sendMessage({
      baseUrl: this.creds.baseurl, token: this.creds.bot_token,
      to, items: [item], contextToken, botAgent: this.botAgent,
      onWarn: (w) => this.pushLog(`发送 ${w}`),
    })
  }

  /**
   * 发一个文件给微信用户：按扩展名发成图片 / 视频 / 文件。先上传到 CDN（加密），再发消息条目；
   * caption 作为单独的文字消息先发。context_token 处理与 sendReply 相同（被拒时换最新的或不带重试一次）。
   * @returns {Promise<{kind: string, name: string, bytes: number}>}（失败抛错）
   */
  async sendFile(to, file, contextToken?) {
    if (!this.creds?.bot_token) throw new Error('微信通道未登录，无法发送')
    const data = Buffer.isBuffer(file?.data) ? file.data : Buffer.from(file?.data ?? [])
    const name = String(file?.name ?? '').trim() || 'file'
    if (!data.length) throw new Error('文件是空的')
    const max = this.maxMediaBytes()
    if (data.length > max) throw new Error(`文件超过 ${Math.round(max / 1024 / 1024)}MB，微信发不了`)
    const kind = ilink.outboundKind(name)
    const mediaType = kind === 'image' ? ilink.UPLOAD_MEDIA_TYPE.IMAGE : kind === 'video' ? ilink.UPLOAD_MEDIA_TYPE.VIDEO : ilink.UPLOAD_MEDIA_TYPE.FILE
    const caption = String(file?.caption ?? '').trim()
    if (caption && !(await this.sendReply(to, contextToken, caption))) {
      throw new Error(this.status.lastSendError?.message ?? '说明文字发送失败')
    }
    const uploaded = await this.uploadMedia({
      baseUrl: this.creds.baseurl, token: this.creds.bot_token, to, data, mediaType, botAgent: this.botAgent,
      cdnBaseUrl: this.cfg.cdnBaseUrl || ilink.CDN_BASE_URL, forceBase: !!this.cfg.cdnBaseUrl,
    })
    const item = ilink.buildMediaItem(kind, uploaded, name)
    let token = this.contextTokens.get(to) ?? contextToken
    const label = kind === 'image' ? '[图片]' : kind === 'video' ? '[视频]' : `[文件] ${name}`
    try {
      await this.paceSend()
      try {
        await this.sendItem(to, token, item)
      } catch (err) {
        if (!(err instanceof ilink.ILinkError) || !token || err.errcode === -14) throw err
        const fresher = this.contextTokens.get(to)
        const retryToken = fresher && fresher !== token ? fresher : undefined
        this.pushLog(`发送被拒（${err.message}），${retryToken ? '换用最新 context_token' : '不带 context_token'} 重试一次`)
        await this.paceSend()
        await this.sendItem(to, retryToken, item)
        token = retryToken
      }
    } catch (err) {
      const expired = err?.errcode === -14
      const message = expired ? '微信登录已过期（errcode -14），请重新扫码登录' : (err?.message ?? String(err))
      this.status.lastSendError = { at: Date.now(), to, message }
      this.pushLog(`发送文件失败（${to.slice(0, 12)}…）：${message}`)
      throw new Error(message)
    }
    if (this.status.lastSendError?.to === to) this.status.lastSendError = null
    this.pushLog(`发：${to.slice(0, 12)}… ${label}（${data.length}B）`)
    this.noteActivity(to, 'outbound', caption ? `${caption} ${label}` : label)
    return { kind, name, bytes: data.length }
  }

  /**
   * 主动推送。供 ctx.weixin 服务调用。有该用户最近的 context_token 就带上，被拒时不带 token 重试（同 sendReply）。
   * @param {string} to 微信用户 id；'all' 广播给所有已建会话用户
   * @param {string} text 要发送的文本（超过 maxChunk 会自动切分）
   * @returns {Promise<{sent: number, failed: number, targets: string[]}>} sent/failed 为真实发送结果（而非目标数）
   */
  async push(to, text) {
    if (!this.creds?.bot_token) throw new Error('微信通道未登录，无法推送')
    const targets = to === 'all' ? Object.keys(this.sessionMap) : [to]
    if (targets.length === 0) throw new Error('没有可推送的目标用户')
    // sent/failed 为真实发送结果，而非目标数（review S5）
    let sent = 0
    let failed = 0
    for (const t of targets) {
      if (await this.sendReply(t, undefined, text)) sent += 1
      else failed += 1
    }
    const failNote = failed > 0 ? `（失败 ${failed}）` : ''
    this.pushLog(`主动推送完成：${text.slice(0, 40)} → 成功 ${sent}/${targets.length}${failNote}`)
    return { sent, failed, targets }
  }

  /** 主动发文件给一个用户（不支持广播）。返回结构与 push 相同，另带 kind/name/bytes；失败时带 error。 */
  async pushFile(to, file) {
    if (!this.creds?.bot_token) throw new Error('微信通道未登录，无法发送')
    if (!to || to === 'all') throw new Error('发文件需要指定一个微信用户（不支持广播）')
    try {
      const r = await this.sendFile(to, file)
      return { sent: 1, failed: 0, targets: [to], ...r }
    } catch (err) {
      return { sent: 0, failed: 1, targets: [to], error: err?.message ?? String(err) }
    }
  }

  /* ------------------------------ 面板用状态 ------------------------------ */

  statusView() {
    this.pruneLogin() // 显式清理过期的登录终态：读路径本身无副作用（review S3 观察项）
    return {
      // 「已连接」= 轮询循环在跑 + 有凭据 + 未过期 + 没有连续失败到不健康
      connected: !this.paused && this.monitorRunning && !!this.creds?.bot_token && !this.status.needsRelogin && (this.status.failures ?? 0) < UNHEALTHY_FAILURES,
      health: !this.creds?.bot_token ? 'logged_out'
        : this.paused ? 'paused'
        : this.status.needsRelogin ? 'needs_relogin'
          : !this.monitorRunning ? 'stopped'
            : (this.status.failures ?? 0) > 0 ? 'retrying' : 'ok',
      needsRelogin: !!this.status.needsRelogin,
      failures: this.status.failures ?? 0,
      loggedInAt: this.creds?.loggedInAt ?? null,
      baseUrl: this.creds?.baseurl ?? null,
      sessionMap: { ...this.sessionMap },
      lastEventAt: this.status.lastEventAt,
      lastError: this.status.lastError,
      lastSendError: this.status.lastSendError ?? null,
      login: this.loginView(),
    }
  }

  /** 登录卡片已到终态（confirmed/error/expired）并超过宽限期，就清空 login 状态（review S3）。 */
  pruneLogin(now = Date.now()) {
    const l = this.login
    if (l?.finishedAt && now - l.finishedAt > LOGIN_DONE_GRACE_MS) {
      this.login = null
    }
  }

  /** 纯读：登录卡片视图。不修改状态，清理由 pruneLogin 显式完成。 */
  loginView() {
    const l = this.login
    if (!l) return { active: false }
    return {
      active: true,
      status: l.status,
      hasQr: !!l.qrUrl && !l.finishedAt,
      message: l.message ?? '',
      startedAt: l.startedAt,
      botId: l.botId ?? null,
      isNew: !!l.isNew,
    }
  }
}

export function apply(ctx, config) {
  const stateDir = resolveStateDir(config.stateDir)
  const cwd = resolveWorkspaceDir(config.cwd, stateDir)
  const store = createStore(stateDir)
  // 多机器人：hub 负责迁移旧数据、为每个机器人建通道、扫码登录与抽屉视图
  const hub = new WeixinHub(ctx, { ...config, cwd }, store, {
    createChannel: (channelStore, options) => new WeixinChannel(ctx, { ...config, cwd }, channelStore, options),
  })
  ctx.effect(() => registerWeixinTransport(ctx, hub, (line) => hub.pushLog(line)), 'dsh-weixin-web: rpc')
  // 对外暴露主动推送能力：其它插件 inject ['weixin'] 后用 ctx.weixin.push / sendAll
  ctx.provide('weixin', {
    push: (to, text, bot) => hub.push(to, text, bot),
    pushFile: (to, file, bot) => hub.pushFile(to, file, bot),
    sendAll: (text) => hub.push('all', text),
    status: () => hub.statusView(),
    sessions: () => hub.sessionMap,
    bots: () => hub.statusView().bots,
  })
  registerPushTool(ctx, hub, { cwd, maxBytes: config.maxMediaBytes })
  registerSendFileTool(ctx, hub, { cwd, maxBytes: config.maxMediaBytes })
  // 启动对账放到后台：等工作区/标题服务就绪后整理已有会话，不阻塞插件激活
  hub.reconcile().catch((err) => hub.pushLog(`启动对账失败：${err?.message ?? err}`))
}

/** 工具调用的默认目标：触发本工具的会话所属微信用户（及其机器人）。 */
function sessionOwner(channel, exec) {
  const sid = exec?.agent?.id
  if (!sid) return null
  if (typeof channel.ownerOfSession === 'function') return channel.ownerOfSession(sid) ?? null
  const userId = Object.keys(channel.sessionMap ?? {}).find((u) => channel.sessionMap[u] === sid)
  return userId ? { userId } : null
}

/** 解析并读取要发送的本地文件（路径限制见 files.mts）。 */
async function loadSendableFile(filePath, exec, opts) {
  const max = Number(opts?.maxBytes) > 0 ? Number(opts.maxBytes) : ilink.DEFAULT_MAX_MEDIA_BYTES
  let sessionCwd
  try { sessionCwd = exec?.agent?.session?.header?.cwd } catch { sessionCwd = undefined }
  const roots = [sessionCwd, opts?.cwd, opts?.attachmentsRoot ?? defaultAttachmentsRoot()]
  const f = await resolveSendableFile(filePath, { cwd: sessionCwd || opts?.cwd, roots, maxBytes: max })
  return { ...f, data: await fsp.readFile(f.path) }
}

const PUSH_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    sent: { type: 'number' },
    failed: { type: 'number' },
    targets: { type: 'array', items: { type: 'string' } },
  },
  required: ['sent', 'failed', 'targets'],
}

/**
 * 注册 push_weixin 主动推送工具：把推送暴露给任意 agent（含 DSH schedule 定时触发回合）。
 * target 可以是 WeixinHub（多机器人，支持 bot 参数）或单个 WeixinChannel。
 * 带 file 时发送该文件（text 作为说明文字），只能发给一个用户。
 */
export function registerPushTool(ctx, channel, opts = {}) {
  return ctx.tools.register({
    name: 'push_weixin',
    description: '主动发送一条消息到微信。to 为微信用户 id；"all" = 广播给所有已建会话用户（仅文本）；省略 = 发给触发本工具的会话所属微信用户。'
      + '可选 file：同时发送一个本地文件（图片/视频/其它文件，≤20MB，text 作为说明文字），带文件时不能广播。适合定时任务、告警等主动触达场景。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '微信用户 id（如 user@im.wechat）；"all" 广播所有已建会话（仅文本）；省略 = 触发本工具的会话所属用户' },
        text: { type: 'string', description: '要发送的文本（超过 maxChunk 自动切分）；带 file 时作为说明文字' },
        file: { type: 'string', description: '可选：要一起发送的文件路径（会话工作目录或 DSH 附件里的文件；相对路径按会话工作目录解析）' },
        bot: { type: 'string', description: '可选：用哪个微信机器人发送（机器人 id 或名字）；省略 = 自动选择与该用户对话的机器人' },
      },
      required: ['text'],
    },
    output: {
      schema: PUSH_RESULT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `微信推送结果：成功 ${value?.sent ?? 0}，失败 ${value?.failed ?? 0}（目标 ${value?.targets?.length ?? 0}）${value?.error ? `：${value.error}` : ''}`,
      }],
    },
    async execute(args, exec) {
      const explicit = args.to && String(args.to).trim()
      const bot = args.bot && String(args.bot).trim() ? String(args.bot).trim() : undefined
      const text = String(args.text ?? '')
      let to = explicit || null
      let viaBot = bot
      if (!to) {
        // 缺省时优先发给触发本工具的会话所属微信用户（schedule 到点醒来正好对应该用户）
        const owner = sessionOwner(channel, exec)
        if (owner) { to = owner.userId; viaBot = viaBot ?? owner.botId }
      }
      const filePath = args.file && String(args.file).trim()
      if (filePath) {
        if (!to || to === 'all') throw new Error('带文件时需要指定一个微信用户（不支持广播）')
        const f = await loadSendableFile(filePath, exec, opts)
        const file = { data: f.data, name: f.name, caption: text }
        return viaBot ? channel.pushFile(to, file, viaBot) : channel.pushFile(to, file)
      }
      to = to || 'all'
      return viaBot ? channel.push(to, text, viaBot) : channel.push(to, text)
    },
  })
}

/**
 * 注册 send_weixin_file：把本地文件发到微信（按扩展名发成图片 / 视频 / 文件）。
 * 默认发给触发本工具的会话所属微信用户；不支持广播。
 */
export function registerSendFileTool(ctx, channel, opts = {}) {
  return ctx.tools.register({
    name: 'send_weixin_file',
    description: '把一个本地文件发给微信用户：.png/.jpg/.gif/.webp 发成图片，.mp4/.mov 发成视频，其它发成文件（≤20MB）。'
      + '只能发送当前会话工作目录、微信工作区或 DSH 附件里的文件。默认发给当前微信会话的用户；caption 可选，作为说明文字先发。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要发送的文件路径（相对路径按会话工作目录解析）' },
        caption: { type: 'string', description: '可选：随文件一起发送的说明文字' },
        to: { type: 'string', description: '可选：微信用户 id；省略 = 当前会话所属的微信用户' },
        bot: { type: 'string', description: '可选：用哪个微信机器人发送（机器人 id 或名字）' },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sent: { type: 'number' },
          kind: { type: 'string' },
          name: { type: 'string' },
          bytes: { type: 'number' },
          to: { type: 'string' },
        },
        required: ['sent', 'kind', 'name', 'bytes', 'to'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已发到微信：${value?.kind === 'image' ? '图片' : value?.kind === 'video' ? '视频' : '文件'}「${value?.name ?? ''}」（${value?.bytes ?? 0} 字节）`,
      }],
    },
    async execute(args, exec) {
      const explicit = args.to && String(args.to).trim()
      if (explicit === 'all') throw new Error('send_weixin_file 不支持广播，请指定一个微信用户')
      let to = explicit || null
      let viaBot = args.bot && String(args.bot).trim() ? String(args.bot).trim() : undefined
      if (!to) {
        const owner = sessionOwner(channel, exec)
        if (!owner) throw new Error('当前会话不是微信会话，请用 to 指定微信用户 id')
        to = owner.userId
        viaBot = viaBot ?? owner.botId
      }
      const f = await loadSendableFile(args.path, exec, opts)
      const file = { data: f.data, name: f.name, caption: args.caption ? String(args.caption) : '' }
      const r = viaBot ? await channel.pushFile(to, file, viaBot) : await channel.pushFile(to, file)
      if (!r?.sent) throw new Error(`发送失败：${r?.error ?? '未知错误'}`)
      return { sent: 1, kind: r.kind, name: r.name, bytes: r.bytes, to }
    },
  })
}

/** 默认日志输出：info → stdout，warn → stderr（systemd 下都进入 journal）。测试可通过 channel.logSink 覆盖。 */
export function defaultLogSink(level, message) {
  if (level === 'warn') process.stderr.write(`${message}\n`)
  else process.stdout.write(`${message}\n`)
}
