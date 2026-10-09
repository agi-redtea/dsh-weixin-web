// @ts-nocheck
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
import { createStore, resolveStateDir, resolveWorkspaceDir } from './creds.mjs'
import { registerWeixinTransport } from './rpc.mjs'
import { WeixinWorkspace, applySessionTitle, defaultBotName, weixinSessionTitle } from './workspace.mjs'
import { WeixinHub } from './hub.mjs'

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
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 可被 AbortSignal 打断的等待（登出 / 重新登录时立即结束退避或暂停）。 */
function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
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

/** 连续失败达到该次数即视为通道不健康（connected=false）。 */
const UNHEALTHY_FAILURES = 3

/** 登录终态（confirmed/error/expired）后面板保留最终提示的时长，之后自动收起卡片（review S3）。 */
const LOGIN_DONE_GRACE_MS = 10_000

export function chunkText(text, max) {
  const limit = Math.max(1, Math.floor(max || 1500))
  const out = []
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
  constructor(ctx, config, store, options = {}) {
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
    this.visionCache = new Map() // `provider:model` -> boolean（模型是否支持图片输入）
    this.contactActivity = new Map() // 微信用户 id -> { lastMessageAt, preview, direction }（仅内存，面板「最近消息」用）
    this.workspace = options.workspace ?? new WeixinWorkspace(ctx, config.cwd, (line) => this.pushLog(line)) // 「微信」工作区分组
    this.logTag = options.logTag ?? null // () => string：多机器人时给日志加机器人名前缀
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
    this.contactActivity.set(userId, { lastMessageAt: Date.now(), preview, direction })
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

  async composeSetup() {
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
            + '信息不足时：优先在回复正文里直接向用户反问，或采用合理默认值并简要说明你的假设。',
        })
      } catch (err) {
        this.pushLog(`注入通道指令失败：${err?.message ?? err}`)
      }
      if (!presets) return
      try {
        const resolved = await presets.resolve(undefined)
        if (resolved?.id) await presets.mount(agentCtx, resolved.id)
      } catch (err) {
        this.pushLog(`agentPresets 装配失败（用默认）：${err?.message ?? err}`)
      }
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
    const source = { kind: 'user', channel: 'dsh-weixin-web', peer: from }
    if (this.creds?.ilink_bot_id) source.bot = this.creds.ilink_bot_id
    return source
  }

  /** 会话呈现：归入「微信」工作区 + 钉住标题。失败只记日志。wait 仅启动对账时使用。 */
  async decorateSession(agent, userId, wait) {
    if (!agent?.id) return
    try {
      await this.workspace.attach(agent.id, wait)
      await applySessionTitle(this.ctx, agent.session, this.titleFor(userId), (line) => this.pushLog(line), wait)
    } catch (err) {
      this.pushLog(`整理会话 ${agent.id} 失败：${err?.message ?? err}`)
    }
  }

  /** 按当前机器人名/对话方数量刷新所有在内存中的会话标题（改名、出现第二个对话方时调用）。 */
  async refreshTitles(wait) {
    for (const [userId, sessionId] of Object.entries(this.sessionMap)) {
      const agent = this.ctx.agents?.get?.(sessionId)
      if (agent) await applySessionTitle(this.ctx, agent.session, this.titleFor(userId), (line) => this.pushLog(line), wait)
    }
  }

  /**
   * 启动对账：确保「微信」工作区存在且排第一，把已映射的会话（未归档）恢复、归组并设置标题。
   * 不新建会话（已归档的会话等下一条消息再新建）。等待宿主服务就绪，最多 waitMs。
   */
  async reconcile({ waitMs = 60_000 } = {}) {
    const wait = { timeoutMs: waitMs }
    await this.workspace.ensure(wait)
    for (const [userId, sessionId] of Object.entries(this.sessionMap)) {
      if (this.stopped && !this.creds) break
      if (this.isSessionArchived(sessionId)) continue
      try {
        let agent = this.ctx.agents?.get?.(sessionId)
        if (!agent) {
          ;({ agent } = await this.ctx.agents.resume({
            resumeSessionId: sessionId, agentOptions: this.resolveDefaultAgentOptions(), setup: await this.composeSetup(),
          }))
          this.applyApprovalPolicy(agent)
        }
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
      const live = this.ctx.agents.get(sessionId)
      if (live) { this.applyApprovalPolicy(live); await this.decorateSession(live, userId); return live }
      try {
        const { agent } = await this.ctx.agents.resume({
          resumeSessionId: sessionId, agentOptions: this.resolveDefaultAgentOptions(), setup: await this.composeSetup(),
        })
        this.pushLog(`恢复持久化会话 ${sessionId}（${userId.slice(0, 12)}…）`)
        this.applyApprovalPolicy(agent)
        await this.decorateSession(agent, userId)
        return agent
      } catch (err) {
        this.pushLog(`恢复会话 ${sessionId} 失败：${err?.message ?? err}，将新建`)
      }
    }

    const newId = `session-${randomUUID()}`
    try {
      const { agent } = await this.ctx.agents.create({
        sessionId: newId,
        agentOptions: this.resolveDefaultAgentOptions(),
        meta: { cwd: this.cfg.cwd },
        setup: await this.composeSetup(),
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

    // 正文：文本优先，其次语音转写（P1：腾讯服务端已 ASR，无需本地识别）
    const bodyText = (msg.text || msg.voiceText || '').trim()
    const hasImage = !!msg.image
    if (!bodyText && !hasImage) {
      await this.sendReply(from, contextToken, '这个格式暂不支持（目前支持文字 / 图片 / 语音）🙏')
      return
    }
    this.pushLog(`收：${from.slice(0, 12)}… ${(bodyText || '[图片]').slice(0, 60)}`)
    this.noteActivity(from, 'inbound', bodyText || '[图片]')

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
    let imageBlock = null
    if (hasImage) {
      if (await this.supportsVision(agent?.options)) {
        if (this.ctx.attachments) imageBlock = await this.resolveImageBlock(msg.image)
      } else if (!bodyText) {
        // 纯图片 + 模型不看图：不注入、不跑模型，直接友好提示，避免污染历史
        this.stopTypingOnce({ from, typingStopped: false })
        await this.sendReply(from, contextToken, '收到你的图片了，但当前模型是纯文本模型，不支持看图 🙏（可发文字描述）')
        return
      }
      // 有文字 + 模型不看图：忽略图片，继续按纯文字处理
    }

    const content = []
    if (bodyText) content.push({ type: 'text', text: bodyText })
    if (imageBlock) content.push(imageBlock)

    const userMessage = makeUserMessage({
      content,
      source: this.messageSource(from),
    })

    await new Promise((resolve) => {
      const pend = { from, contextToken, sessionId: agent.id, resolve, timer: null, typingStopped: false }
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
   * 判断会话所用模型是否支持图片输入（保守：无法判断/查不到一律视为不支持）。
   * 结果按 `provider:model` 缓存，避免每张图都请求模型元数据。
   */
  async supportsVision(agentOptions) {
    try {
      const llm = this.ctx.get?.('llm')
      const am = this.ctx.get?.('agentDefaultModel')
      if (!llm) return false
      const sel = am?.currentSelection?.() ?? {}
      const provider = agentOptions?.provider || sel.provider
      const model = agentOptions?.model || sel.model
      if (!provider || !model) return false
      const key = `${provider}:${model}`
      if (this.visionCache.has(key)) return this.visionCache.get(key)
      const info = await llm.resolveModelInfo(provider, model)
      const ok = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
      this.visionCache.set(key, ok)
      return ok
    } catch {
      return false
    }
  }

  /** 把微信图片下载解密后存成 Harness 图片附件，返回 image 内容块；失败/超限降级为文本块。 */
  async resolveImageBlock(image) {
    const limits = this.ctx.attachments?.imageLimits
    const maxBytes = limits?.maxImageBytes ?? 0
    try {
      const bytes = await this.downloadImageBytes({
        encryptQueryParam: image.encrypt_query_param,
        fullUrl: image.full_url,
        aesKey: image.aesKey,
      })
      if (maxBytes && bytes.byteLength > maxBytes) {
        this.pushLog(`图片超限 ${bytes.byteLength}B > ${maxBytes}B，略过图片理解`)
        return { type: 'text', text: '[图片过大，未处理]' }
      }
      const attachment = await this.ctx.attachments.saveImage({
        data: bytes, // Buffer 即 Uint8Array
        mediaType: ilink.sniffImageMime(bytes),
      })
      return { type: 'image', attachment }
    } catch (err) {
      this.pushLog(`图片下载/解密/入库失败：${err?.message ?? err}`)
      return { type: 'text', text: '[图片处理失败]' }
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
    const out = []
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
    sendAll: (text) => hub.push('all', text),
    status: () => hub.statusView(),
    sessions: () => hub.sessionMap,
    bots: () => hub.statusView().bots,
  })
  registerPushTool(ctx, hub)
  // 启动对账放到后台：等工作区/标题服务就绪后整理已有会话，不阻塞插件激活
  hub.reconcile().catch((err) => hub.pushLog(`启动对账失败：${err?.message ?? err}`))
}

/**
 * 注册 push_weixin 主动推送工具：把推送暴露给任意 agent（含 DSH schedule 定时触发回合）。
 * target 可以是 WeixinHub（多机器人，支持 bot 参数）或单个 WeixinChannel。
 */
export function registerPushTool(ctx, channel) {
  return ctx.tools.register({
    name: 'push_weixin',
    description: '主动发送一条文本消息到微信。to 为微信用户 id；"all" = 广播给所有已建会话用户；省略 = 发给触发本工具的会话所属微信用户。适合定时任务、告警等主动触达场景。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '微信用户 id（如 user@im.wechat）；"all" 广播所有已建会话；省略 = 触发本工具的会话所属用户' },
        text: { type: 'string', description: '要发送的文本（超过 maxChunk 自动切分）' },
        bot: { type: 'string', description: '可选：用哪个微信机器人发送（机器人 id 或名字）；省略 = 自动选择与该用户对话的机器人' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sent: { type: 'number' },
          failed: { type: 'number' },
          targets: { type: 'array', items: { type: 'string' } },
        },
        required: ['sent', 'failed', 'targets'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `微信推送结果：成功 ${value?.sent ?? 0}，失败 ${value?.failed ?? 0}（目标 ${value?.targets?.length ?? 0}）`,
      }],
    },
    async execute(args, exec) {
      const explicit = args.to && String(args.to).trim()
      const bot = args.bot && String(args.bot).trim() ? String(args.bot).trim() : undefined
      let to = explicit || null
      let viaBot = bot
      if (!to) {
        // 缺省时优先发给触发本工具的会话所属微信用户（schedule 到点醒来正好对应该用户），否则广播
        const sid = exec?.agent?.id
        if (sid && typeof channel.ownerOfSession === 'function') {
          const owner = channel.ownerOfSession(sid)
          if (owner) { to = owner.userId; viaBot = viaBot ?? owner.botId }
        } else if (sid) {
          to = Object.keys(channel.sessionMap).find((u) => channel.sessionMap[u] === sid) ?? null
        }
        to = to || 'all'
      }
      return viaBot ? channel.push(to, String(args.text ?? ''), viaBot) : channel.push(to, String(args.text ?? ''))
    },
  })
}

/** 默认日志输出：info → stdout，warn → stderr（systemd 下都进入 journal）。测试可通过 channel.logSink 覆盖。 */
export function defaultLogSink(level, message) {
  if (level === 'warn') process.stderr.write(`${message}\n`)
  else process.stdout.write(`${message}\n`)
}
