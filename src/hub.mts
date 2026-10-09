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
import { contactDisplayName, contactsView } from './rpc.mjs'
import { isDefaultSettings, mergeSettings, normalizeSettings } from './settings.mjs'

/** 最多绑定的机器人数（iLink get_bot_qrcode 的 local_token_list 上限也是 10）。 */
export const MAX_BOTS = 10
/** 旧版已登出但留有会话映射时的占位键：下一个新绑定的机器人接手这些会话。 */
export const UNBOUND_KEY = '__unbound__'
/** 机器人名最长字符数。 */
export const MAX_BOT_NAME = 32
const LOGIN_DONE_GRACE_MS = 10_000

const BOT_FIELDS = ['bot_token', 'baseurl', 'ilink_bot_id', 'ilink_user_id', 'loggedInAt', 'name', 'enabled']

export class WeixinHub {
  [key: string]: any
  /**
   * @param ctx cordis 上下文
   * @param config 插件配置（cwd 已解析）
   * @param store createStore(stateDir) 的结果
   * @param options.createChannel (channelStore, channelOptions) => WeixinChannel
   */
  constructor(ctx, config, store, options: any = {}) {
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
    this.pruneSupersededMaps()
    this.activity = store.loadActivity?.() ?? {} // { botId: { 微信用户: { lastMessageAt, preview, direction } } }
    this.activityTimer = null
    for (const bot of this.bots) this.spawn(bot)
    if (!this.bots.length) this.pushLog('未绑定微信机器人，等待 DSH 原生扫码登录')
    ctx.on?.('dispose', () => this.flushActivity())
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
    const bots: any[] = []
    const maps: Record<string, any> = {}
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

  /**
   * 清理「已被接替」的会话映射：映射键不是任何现有机器人（也不是旧版占位键），而其中的对话方
   * 已经映射在某个现有机器人下（同一微信号重新绑定后换了机器人 id）。这些旧条目永远不会再被用到，
   * 只会在启动对账/视图里制造噪音。会话本身留在 DSH 里不动；仍然独有的对话方保留（以后重新绑定可接上）。
   */
  pruneSupersededMaps() {
    const botIds = new Set<string>(this.bots.map((b) => b.id))
    const live = new Set<string>()
    for (const id of botIds) for (const peer of Object.keys(this.maps[id] ?? {})) live.add(peer)
    let removed = 0
    for (const key of Object.keys(this.maps)) {
      if (botIds.has(key) || key === UNBOUND_KEY) continue
      const map = this.maps[key]
      if (!map || typeof map !== 'object') continue
      for (const peer of Object.keys(map)) {
        if (live.has(peer)) { delete map[peer]; removed += 1 }
      }
      if (!Object.keys(map).length) delete this.maps[key]
    }
    if (removed) {
      this.store.saveSessionMaps(this.maps)
      this.pushLog(`已清理 ${removed} 条被新绑定接替的旧会话映射（会话本身保留在 DSH 中）`)
    }
    return removed
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
      activity: this.activity[bot.id] ?? {},
      onActivity: (userId, entry) => this.noteActivity(bot.id, userId, entry),
    }
    ch = this.createChannel(this.botStore(bot.id), options)
    this.channels.set(bot.id, ch)
    return ch
  }

  channel(id) {
    return this.channels.get(id)
  }

  /** 记录最近消息并延迟落盘（重启后消息列表仍有预览与时间）。 */
  noteActivity(botId, userId, entry) {
    ;(this.activity[botId] ||= {})[userId] = entry
    if (this.activityTimer || typeof this.store.saveActivity !== 'function') return
    this.activityTimer = setTimeout(() => this.flushActivity(), 1000)
    this.activityTimer.unref?.()
  }

  flushActivity() {
    if (this.activityTimer) clearTimeout(this.activityTimer)
    this.activityTimer = null
    try { this.store.saveActivity?.(this.activity) } catch (err) { this.pushLog(`保存最近消息失败：${err?.message ?? err}`) }
  }

  /**
   * 联系人显示名：iLink 里机器人与扫码微信号一一对应，扫码人本人（ilink_user_id）就显示为机器人名；
   * 旧数据缺 ilink_user_id 且只有一个对话方时同样视为本人；其它对话方用「微信用户 xxxxxx」。
   */
  peerName(bot, peerId, peerCount, botName) {
    const owner = bot.ilink_user_id ? peerId === bot.ilink_user_id : peerCount === 1
    return owner ? botName : contactDisplayName(peerId)
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

  /**
   * 更新机器人个性化设置（人设/模型/预设）。模型、预设会先校验在 DSH 里存在。
   * 人设、模型对该机器人的所有会话下一轮起生效；预设只对之后新建的对话生效。
   */
  async updateBotSettings(id, patch) {
    const bot = this.requireBot(id)
    const next = mergeSettings(bot.settings, patch)
    if (patch && patch.model !== undefined && next.model) await this.assertModelAvailable(next.model)
    if (patch && patch.preset !== undefined && next.preset) await this.assertPresetAvailable(next.preset)
    if (isDefaultSettings(next)) delete bot.settings
    else bot.settings = next
    this.saveBots()
    const ch = this.channels.get(id)
    if (ch?.creds) ch.creds.settings = bot.settings ? { ...bot.settings } : undefined
    const parts: string[] = []
    if (patch?.persona !== undefined) parts.push(next.persona ? `人设 ${next.persona.length} 字` : '人设清空')
    if (patch?.model !== undefined) parts.push(next.model ? `模型 ${next.model.provider}/${next.model.model}` : '模型跟随默认')
    if (patch?.preset !== undefined) parts.push(next.preset ? `预设 ${next.preset}（新对话生效）` : '预设跟随默认')
    this.pushLog(`机器人「${ch?.botName() ?? id}」设置已更新：${parts.join('，') || '无变化'}`)
    return bot
  }

  async assertModelAvailable(model) {
    const llm = this.ctx.get?.('llm')
    if (!llm) return
    const providers = (() => { try { return llm.listProviders?.() ?? [] } catch { return [] } })()
    if (providers.length && !providers.some((p) => (p?.id ?? p?.name) === model.provider)) {
      throw new Error(`DSH 里没有模型服务商「${model.provider}」`)
    }
    try {
      await llm.resolveModelInfo(model.provider, model.model)
    } catch (err) {
      throw new Error(`模型 ${model.provider}/${model.model} 不可用：${err?.message ?? err}`)
    }
  }

  async assertPresetAvailable(presetId) {
    const presets = this.ctx.get?.('agentPresets')
    if (!presets) throw new Error('DSH 没有预设服务，不能指定预设')
    const resolved = await presets.resolve(presetId) // 未知预设会抛 agent-preset/not-found
    if (resolved?.broken) throw new Error(`预设「${presetId}」当前不可用：${String(resolved.broken).split('\n')[0]}`)
  }

  /** 设置面板的下拉选项：可用模型（含是否能看图）、预设，以及 DSH 当前默认值。 */
  async settingsOptions() {
    const llm = this.ctx.get?.('llm')
    const models: any[] = []
    let providers: any[] = []
    try { providers = llm?.listProviders?.() ?? [] } catch { providers = [] }
    for (const p of providers) {
      const pid = p?.id ?? p?.name
      if (!pid) continue
      try {
        for (const m of await llm.listModels(pid)) {
          models.push({
            provider: pid,
            model: m.id,
            name: m.name || m.id,
            providerName: p?.displayName ?? p?.name ?? pid,
            vision: Array.isArray(m.inputModalities) ? m.inputModalities.includes('image') : null,
          })
        }
      } catch (err) {
        this.pushLog(`读取 ${pid} 模型列表失败：${err?.message ?? err}`)
      }
    }
    let defaultModel: any = null
    try {
      const sel = this.ctx.get?.('agentDefaultModel')?.currentSelection?.()
      if (sel?.provider && sel?.model) defaultModel = { provider: sel.provider, model: sel.model }
    } catch { defaultModel = null }
    const presetSvc = this.ctx.get?.('agentPresets')
    let presets = []
    let defaultPreset = null
    try {
      presets = (await presetSvc?.list?.() ?? []).map((r) => ({ id: r.id, name: r.name ?? r.id, description: r.description ?? '', broken: !!r.broken }))
    } catch (err) {
      this.pushLog(`读取预设列表失败：${err?.message ?? err}`)
    }
    try { defaultPreset = (await presetSvc?.resolve?.(undefined))?.id ?? null } catch { defaultPreset = null }
    return { models, defaultModel, presets, defaultPreset, maxPersona: 4000 }
  }

  /** 开始新对话（抽屉按钮）：该联系人之后的消息进入新会话；旧会话保留。 */
  async startNewChat(id, peer) {
    this.requireBot(id)
    const ch = this.channels.get(id)
    if (!ch) throw new Error(`未找到机器人：${id}`)
    return ch.startNewChat(peer)
  }

  /** 旧版抽屉的「退出登录」：解绑全部机器人。 */
  async clearCredentials() {
    for (const bot of [...this.bots]) await this.deleteBot(bot.id)
    this.pushLog('已登出')
  }

  /* ------------------------------ 会话 ------------------------------ */

  /** 启动对账：确保工作区，然后逐个机器人整理已有会话。 */
  async reconcile(options?) {
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
  async push(to, text, botRef?) {
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
      const sum: { sent: number, failed: number, targets: string[] } = { sent: 0, failed: 0, targets: [] }
      for (const c of targets) {
        const r = await c.push('all', text)
        sum.sent += r.sent; sum.failed += r.failed; sum.targets.push(...r.targets)
      }
      return sum
    }
    const ch = live.find((c) => to in c.sessionMap) ?? all.find((c) => to in c.sessionMap) ?? live[0] ?? all[0]
    return ch.push(to, text)
  }

  /**
   * 主动发文件（图片/视频/文件）给一个微信用户；不支持广播。选机器人的规则同 push。
   * file = { data: Buffer, name: string, caption?: string }
   */
  async pushFile(to, file, botRef?) {
    if (!to || to === 'all') throw new Error('发文件需要指定一个微信用户（不支持广播）')
    if (botRef) {
      const bot = this.resolveBot(botRef)
      if (!bot) throw new Error(`未找到机器人：${botRef}`)
      return this.channels.get(bot.id).pushFile(to, file)
    }
    const all = [...this.channels.values()].filter((c) => c.creds?.bot_token)
    const live = all.filter((c) => !c.paused)
    if (!all.length) throw new Error('微信通道未登录，无法发送')
    const ch = live.find((c) => to in c.sessionMap) ?? all.find((c) => to in c.sessionMap) ?? live[0] ?? all[0]
    return ch.pushFile(to, file)
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
    const name = ch.botName()
    const peers = Object.keys(s.sessionMap ?? {})
    const contacts = contactsView(s.sessionMap, ch.contactActivity).map((c) => {
      const display = this.peerName(bot, c.id, peers.length, name)
      return { ...c, name: display, owner: display === name, botId: bot.id, botName: name }
    })
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
      contacts,
      settings: normalizeSettings(bot.settings),
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
      // 全部机器人的统一会话列表（按最近消息倒序，没有消息记录的排后面）
      conversations: bots.flatMap((b) => b.contacts.map((c) => ({ ...c, enabled: b.enabled, health: b.health })))
        .sort((x, y) => (y.lastMessageAt ?? 0) - (x.lastMessageAt ?? 0)),
      totalContacts: bots.reduce((n, b) => n + b.contacts.length, 0),
    }
  }
}
