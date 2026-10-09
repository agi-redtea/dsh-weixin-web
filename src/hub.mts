// @ts-nocheck
/**
 * 多微信机器人管理：每个机器人（一个 iLink bot_token）一个 WeixinChannel，共享「微信」工作区、
 * 预设/模型/工作目录。hub 负责：旧版单机器人数据迁移、扫码登录（新增或重新登录）、改名、
 * 暂停/恢复、解绑，以及抽屉与 ctx.weixin 用的汇总视图。
 *
 * 存储（stateDir）：bots.json / session-map.v2.json / bufs/<botId>.json；
 * 旧版 credentials.json 迁移后保留不动，旧版机器人的游标与会话映射继续同步写回旧文件，方便回滚。
 */

import * as ilink from './ilink.mjs'
import { WeixinWorkspace, defaultBotName, idTail } from './workspace.mjs'
import { contactsView } from './rpc.mjs'

/** 最多绑定的机器人数（iLink get_bot_qrcode 的 local_token_list 上限也是 10）。 */
export const MAX_BOTS = 10
/** 旧版已登出但留有会话映射时的占位键：下一个新绑定的机器人接手这些会话。 */
export const UNBOUND_KEY = '__unbound__'
/** 机器人名最长字符数。 */
export const MAX_BOT_NAME = 32
const LOGIN_DONE_GRACE_MS = 10_000

const BOT_FIELDS = ['bot_token', 'baseurl', 'ilink_bot_id', 'ilink_user_id', 'loggedInAt', 'name', 'enabled']

export class WeixinHub {
  /**
   * @param ctx cordis 上下文
   * @param config 插件配置（cwd 已解析）
   * @param store createStore(stateDir) 的结果
   * @param options.createChannel (channelStore, channelOptions) => WeixinChannel
   */
  constructor(ctx, config, store, options = {}) {
    this.ctx = ctx
    this.cfg = config
    this.store = store
    this.log = ctx.logger ?? console
    this.logs = []
    this.login = null
    this.loginBaseUrl = config.loginBaseUrl || ''
    this.workspace = new WeixinWorkspace(ctx, config.cwd, (line) => this.pushLog(line))
    this.createChannel = options.createChannel
    if (typeof this.createChannel !== 'function') throw new Error('WeixinHub 需要 createChannel')
    this.channels = new Map() // botId -> WeixinChannel

    this.migrate()
    this.bots = store.loadBots()
    this.maps = store.loadSessionMaps()
    for (const bot of this.bots) this.spawn(bot)
    if (!this.bots.length) this.pushLog('未绑定微信机器人，等待 DSH 原生扫码登录')
  }

  /* ------------------------------ 日志 ------------------------------ */

  pushLog(line) {
    const entry = `[${new Date().toISOString().slice(11, 19)}] ${line}`
    this.logs.push(entry)
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300)
    const level = /失败|异常|过期|超时|错误|error/i.test(line) ? 'warn' : 'info'
    const message = `[dsh-weixin-web] ${line}`
    try {
      if (this.logSink) this.logSink(level, message)
      else if (level === 'warn') process.stderr.write(`${message}\n`)
      else process.stdout.write(`${message}\n`)
    } catch { /* ignore */ }
    try {
      const fn = this.log?.[level] ?? this.log?.info
      if (typeof fn === 'function' && this.log !== console) fn.call(this.log, message)
    } catch { /* ignore */ }
  }

  /* ------------------------------ 存储 ------------------------------ */

  /** 首次启动（无 bots.json）：把旧版单机器人的凭据/会话映射/游标搬到 v2 结构。旧文件不删不改。 */
  migrate() {
    const store = this.store
    if (store.hasBots()) return
    const legacy = store.loadCredentials()
    const legacyMap = store.loadSessionMap() ?? {}
    const legacyBuf = store.loadBuf()
    const bots = []
    const maps = {}
    const sessions = Object.keys(legacyMap).length
    if (legacy?.bot_token) {
      const id = legacy.ilink_bot_id || 'legacy'
      bots.push({
        id,
        name: '',
        bot_token: legacy.bot_token,
        baseurl: legacy.baseurl || ilink.DEFAULT_BASE_URL,
        ilink_bot_id: legacy.ilink_bot_id ?? '',
        ilink_user_id: legacy.ilink_user_id ?? '',
        loggedInAt: legacy.loggedInAt ?? null,
        enabled: true,
        addedAt: legacy.loggedInAt ?? Date.now(),
        legacy: true,
      })
      if (sessions) maps[id] = { ...legacyMap }
      if (legacyBuf) store.saveBotBuf(id, legacyBuf)
    } else if (sessions) {
      maps[UNBOUND_KEY] = { ...legacyMap }
    }
    store.saveSessionMaps(maps)
    store.saveBots(bots) // 最后写 bots.json：它的存在即「迁移完成」标记
    if (bots.length || sessions) {
      this.pushLog(`已迁移旧版数据：${bots.length} 个机器人、${sessions} 个会话（旧文件保留不动）`)
    }
  }

  bot(id) {
    return this.bots.find((b) => b.id === id)
  }

  saveBots() {
    this.store.saveBots(this.bots)
  }

  /** 合并凭据字段到机器人记录（id/addedAt/legacy 不变）。 */
  updateBot(id, cred) {
    const bot = this.bot(id)
    if (!bot || !cred) return
    for (const k of BOT_FIELDS) if (cred[k] !== undefined) bot[k] = cred[k]
    this.saveBots()
  }

  /** 单个机器人视角的存储（WeixinChannel 只认识 v1 风格的接口）。 */
  botStore(id) {
    const hub = this
    const store = this.store
    return {
      dir: store.dir,
      loadCredentials: () => { const b = hub.bot(id); return b ? { ...b } : null },
      saveCredentials: (cred) => { if (cred) hub.updateBot(id, cred) },
      loadSessionMap: () => ({ ...(hub.maps[id] ?? {}) }),
      saveSessionMap: (map) => {
        hub.maps[id] = { ...map }
        store.saveSessionMaps(hub.maps)
        if (hub.bot(id)?.legacy) store.saveSessionMap(map) // 回滚兼容：旧版机器人同步写旧文件
      },
      loadBuf: () => store.loadBotBuf(id),
      saveBuf: (buf) => {
        store.saveBotBuf(id, buf)
        if (hub.bot(id)?.legacy) store.saveBuf(buf)
      },
    }
  }

  spawn(bot) {
    let ch
    const options = {
      workspace: this.workspace,
      logTag: () => (this.bots.length > 1 && ch ? `〔${ch.botName()}〕` : ''),
    }
    ch = this.createChannel(this.botStore(bot.id), options)
    this.channels.set(bot.id, ch)
    return ch
  }

  channel(id) {
    return this.channels.get(id)
  }

  /** 按 id、ilink_bot_id 或名字找机器人。 */
  resolveBot(ref) {
    if (!ref) return undefined
    const r = String(ref).trim()
    return this.bots.find((b) => b.id === r)
      ?? this.bots.find((b) => b.ilink_bot_id === r)
      ?? this.bots.find((b) => (this.channels.get(b.id)?.botName() ?? '') === r)
  }

  /* ------------------------------ 登录（login.mjs 调用） ------------------------------ */

  localTokenList() {
    return this.bots.map((b) => b.bot_token).filter(Boolean).slice(0, MAX_BOTS)
  }

  hasAnyBot() {
    return this.bots.some((b) => b.bot_token)
  }

  /**
   * 扫码确认后保存凭据：同一机器人（ilink_bot_id 相同）或同一扫码微信号（ilink_user_id 相同，iLink 一个微信号只绑一个机器人）
   * 视为重新登录，沿用原记录（名字、会话保留）；否则新增，超过上限抛错。
   * @returns {{ botId: string, isNew: boolean }}
   */
  applyCredentials(cred) {
    const existing = (cred.ilink_bot_id && this.bots.find((b) => b.ilink_bot_id === cred.ilink_bot_id))
      || (cred.ilink_user_id && this.bots.find((b) => b.ilink_user_id === cred.ilink_user_id))
    if (existing) {
      existing.enabled = true
      const ch = this.channels.get(existing.id)
      ch.applyCredentials({ ...existing, ...cred, enabled: true })
      this.pushLog(`机器人「${ch.botName()}」已重新登录`)
      return { botId: existing.id, isNew: false }
    }
    if (this.bots.length >= MAX_BOTS) {
      throw new Error(`最多绑定 ${MAX_BOTS} 个微信机器人，请先解绑不用的机器人`)
    }
    let id = cred.ilink_bot_id || `bot-${Date.now()}`
    while (this.bot(id)) id = `${id}-1`
    const bot = {
      id,
      name: '',
      bot_token: cred.bot_token,
      baseurl: cred.baseurl || ilink.DEFAULT_BASE_URL,
      ilink_bot_id: cred.ilink_bot_id ?? '',
      ilink_user_id: cred.ilink_user_id ?? '',
      loggedInAt: cred.loggedInAt ?? Date.now(),
      enabled: true,
      addedAt: Date.now(),
    }
    // 旧版登出前留下的会话：交给第一个新绑定的机器人（与旧版「重新登录沿用会话」一致）
    if (this.maps[UNBOUND_KEY]) {
      this.maps[id] = { ...this.maps[UNBOUND_KEY], ...(this.maps[id] ?? {}) }
      delete this.maps[UNBOUND_KEY]
      this.store.saveSessionMaps(this.maps)
    }
    this.bots.push(bot)
    this.saveBots()
    const ch = this.spawn(bot)
    this.pushLog(`新增微信机器人「${ch.botName()}」（共 ${this.bots.length} 个）`)
    ch.reconcile?.({ waitMs: 0 }).catch?.(() => {})
    return { botId: id, isNew: true }
  }

  /* ------------------------------ 机器人管理 ------------------------------ */

  requireBot(id) {
    const bot = this.bot(id)
    if (!bot) throw new Error(`未找到机器人：${id}`)
    return bot
  }

  /** 改名：空名恢复默认名；同步刷新该机器人所有会话标题。 */
  async renameBot(id, name) {
    const bot = this.requireBot(id)
    const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_BOT_NAME)
    bot.name = clean
    this.saveBots()
    const ch = this.channels.get(id)
    if (ch?.creds) ch.creds.name = clean
    this.pushLog(`机器人 ${idTail(bot.ilink_bot_id || id)} 改名为「${ch?.botName() ?? clean}」`)
    await ch?.refreshTitles?.()
    return bot
  }

  async pauseBot(id) {
    const bot = this.requireBot(id)
    bot.enabled = false
    this.saveBots()
    const ch = this.channels.get(id)
    if (ch?.creds) ch.creds.enabled = false
    await ch?.pause()
    return bot
  }

  resumeBot(id) {
    const bot = this.requireBot(id)
    bot.enabled = true
    this.saveBots()
    const ch = this.channels.get(id)
    if (ch?.creds) ch.creds.enabled = true
    ch?.resume()
    return bot
  }

  /** 解绑：停轮询并通知 iLink 下线，删除本地凭据与游标；会话与映射保留（再次绑定同一机器人可接上）。 */
  async deleteBot(id) {
    const bot = this.requireBot(id)
    const ch = this.channels.get(id)
    const label = ch?.botName() ?? id
    this.channels.delete(id)
    await ch?.dispose()
    this.bots = this.bots.filter((b) => b.id !== id)
    this.saveBots()
    this.store.removeBotBuf(id)
    this.pushLog(`已解绑机器人「${label}」（会话保留）`)
    return bot
  }

  /** 旧版抽屉的「退出登录」：解绑全部机器人。 */
  async clearCredentials() {
    for (const bot of [...this.bots]) await this.deleteBot(bot.id)
    this.pushLog('已登出')
  }

  /* ------------------------------ 会话 ------------------------------ */

  /** 启动对账：确保工作区，然后逐个机器人整理已有会话。 */
  async reconcile(options) {
    await this.workspace.ensure({ timeoutMs: options?.waitMs ?? 60_000 })
    for (const ch of [...this.channels.values()]) {
      try { await ch.reconcile(options) } catch (err) { this.pushLog(`启动对账失败：${err?.message ?? err}`) }
    }
  }

  /** 所有机器人的会话映射合并（旧版视图/ctx.weixin.sessions 用）。 */
  get sessionMap() {
    const out = {}
    for (const ch of this.channels.values()) Object.assign(out, ch.sessionMap)
    return out
  }

  /** 合并各通道最近消息（同一联系人取最新）。 */
  get contactActivity() {
    const out = new Map()
    for (const ch of this.channels.values()) {
      for (const [k, v] of ch.contactActivity ?? []) {
        if (!out.has(k) || (out.get(k).lastMessageAt ?? 0) < (v.lastMessageAt ?? 0)) out.set(k, v)
      }
    }
    return out
  }

  /** 会话 → { botId, userId }。 */
  ownerOfSession(sessionId) {
    for (const [botId, ch] of this.channels) {
      const userId = Object.keys(ch.sessionMap).find((u) => ch.sessionMap[u] === sessionId)
      if (userId) return { botId, userId }
    }
    return undefined
  }

  /**
   * 主动推送。bot 指定时只用该机器人；to='all' 用每个在线机器人广播给各自的联系人；
   * 否则选与该用户对话过的机器人（优先未暂停的），都没有则用第一个未暂停的机器人。
   */
  async push(to, text, botRef) {
    if (botRef) {
      const bot = this.resolveBot(botRef)
      if (!bot) throw new Error(`未找到机器人：${botRef}`)
      return this.channels.get(bot.id).push(to, text)
    }
    const all = [...this.channels.values()].filter((c) => c.creds?.bot_token)
    const live = all.filter((c) => !c.paused)
    if (!all.length) throw new Error('微信通道未登录，无法推送')
    if (to === 'all') {
      const targets = live.filter((c) => Object.keys(c.sessionMap).length)
      if (!targets.length) throw new Error('没有可推送的目标用户')
      const sum = { sent: 0, failed: 0, targets: [] }
      for (const c of targets) {
        const r = await c.push('all', text)
        sum.sent += r.sent; sum.failed += r.failed; sum.targets.push(...r.targets)
      }
      return sum
    }
    const ch = live.find((c) => to in c.sessionMap) ?? all.find((c) => to in c.sessionMap) ?? live[0] ?? all[0]
    return ch.push(to, text)
  }

  /* ------------------------------ 视图 ------------------------------ */

  pruneLogin(now = Date.now()) {
    const l = this.login
    if (l?.finishedAt && now - l.finishedAt > LOGIN_DONE_GRACE_MS) this.login = null
  }

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

  botView(bot) {
    const ch = this.channels.get(bot.id)
    const s = ch.statusView()
    return {
      id: bot.id,
      name: ch.botName(),
      customName: bot.name || '',
      defaultName: defaultBotName(bot.ilink_bot_id || bot.id),
      idTail: idTail(bot.ilink_bot_id || bot.id),
      enabled: bot.enabled !== false,
      health: s.health,
      connected: s.connected,
      needsRelogin: s.needsRelogin,
      failures: s.failures,
      loggedInAt: s.loggedInAt,
      addedAt: bot.addedAt ?? null,
      lastEventAt: s.lastEventAt,
      lastError: s.lastError,
      lastSendError: s.lastSendError,
      sessionMap: s.sessionMap,
      contacts: contactsView(s.sessionMap, ch.contactActivity),
    }
  }

  /** 汇总视图：保留旧版单机器人字段（旧抽屉可用），另加 bots[]。 */
  statusView() {
    this.pruneLogin()
    const bots = this.bots.map((b) => this.botView(b))
    const active = bots.filter((b) => b.enabled)
    const latest = (key) => bots.reduce((m, b) => (b[key] && b[key] > (m ?? 0) ? b[key] : m), null)
    const health = !bots.length ? 'logged_out'
      : bots.some((b) => b.health === 'needs_relogin') ? 'needs_relogin'
        : !active.length ? 'paused'
          : active.some((b) => b.health === 'retrying') ? 'retrying'
            : active.every((b) => b.health === 'stopped') ? 'stopped' : 'ok'
    const sendErrors = bots.map((b) => b.lastSendError).filter(Boolean).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    return {
      connected: active.some((b) => b.connected),
      health,
      needsRelogin: bots.some((b) => b.needsRelogin),
      failures: Math.max(0, ...bots.map((b) => b.failures ?? 0)),
      loggedInAt: latest('loggedInAt'),
      baseUrl: this.bots[0]?.baseurl ?? null,
      sessionMap: this.sessionMap,
      lastEventAt: latest('lastEventAt'),
      lastError: bots.find((b) => b.lastError)?.lastError ?? null,
      lastSendError: sendErrors[0] ?? null,
      login: this.loginView(),
      bots,
      maxBots: MAX_BOTS,
    }
  }
}
