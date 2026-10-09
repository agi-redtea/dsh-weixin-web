import { qrSvg, startLogin, submitVerifyCode } from './login.mjs'

const CHANNEL = '/dsh-weixin-web'
const errorEnvelope = (error) => ({
  ok: false,
  error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
})

/** iLink 不下发昵称：用 id 前缀的末 6 位做可读的兜底名，完整 id 另行返回。 */
export function contactDisplayName(id) {
  const local = String(id ?? '').split('@')[0]
  return local ? `微信用户 ${local.slice(-6)}` : '微信用户'
}

/** 抽屉联系人列表：会话映射 + 本次运行内最近一条消息，按最近活动倒序。 */
export function contactsView(sessionMap = {}, activity = new Map()) {
  return Object.entries(sessionMap)
    .map(([id, sessionId]) => {
      const last = activity.get(id)
      return {
        id,
        sessionId,
        name: contactDisplayName(id),
        lastMessageAt: last?.lastMessageAt ?? null,
        preview: last?.preview ?? '',
        direction: last?.direction ?? null,
      }
    })
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
}

export function view(channel) {
  const status = channel.statusView()
  return {
    ...status,
    qrSvg: status.login?.hasQr ? qrSvg(channel.login.qrUrl) : null,
    // 多机器人：用 hub 的统一会话列表（联系人名 = 机器人名）；单通道沿用旧算法
    contacts: Array.isArray(status.conversations) ? status.conversations : contactsView(status.sessionMap || {}, channel.contactActivity),
  }
}

/** bot/* 端点的 botId 参数校验。 */
function requireBotId(body) {
  const id = typeof body.botId === 'string' ? body.botId.trim() : ''
  if (!id) throw new Error('缺少 botId')
  return id
}

/** 机器人管理端点需要 WeixinHub（单通道对象没有这些方法）。 */
function requireHub(channel, method) {
  if (typeof channel?.[method] !== 'function') throw new Error('当前版本不支持多机器人管理')
}

/**
 * 抽屉 RPC 端点实现：status / login/start / login/verify / logout，
 * 以及机器人管理 bot/rename {botId,name} / bot/pause {botId} / bot/resume {botId} / bot/delete {botId}，
 * 机器人设置 bot/options（下拉选项）/ bot/settings {botId, persona?, model?, preset?} / bot/new-chat {botId, peer}。
 * 返回 Connection RPC 结果信封；成功时 value 为最新视图。
 */
export function createWeixinRpcHandler(channel) {
  return async (endpoint, payload) => {
    try {
      const body = payload && typeof payload === 'object' ? payload : {}
      if (endpoint === 'status') return { ok: true, value: view(channel) }
      if (endpoint === 'login/start') {
        await startLogin(channel)
        return { ok: true, value: view(channel) }
      }
      if (endpoint === 'login/verify') {
        const result = submitVerifyCode(channel, body.code ?? '')
        return { ok: true, value: { ...view(channel), result } }
      }
      if (endpoint === 'logout') {
        await channel.clearCredentials()
        return { ok: true, value: view(channel) }
      }
      if (endpoint === 'bot/rename') {
        requireHub(channel, 'renameBot')
        await channel.renameBot(requireBotId(body), typeof body.name === 'string' ? body.name : '')
        return { ok: true, value: view(channel) }
      }
      if (endpoint === 'bot/pause') {
        requireHub(channel, 'pauseBot')
        await channel.pauseBot(requireBotId(body))
        return { ok: true, value: view(channel) }
      }
      if (endpoint === 'bot/resume') {
        requireHub(channel, 'resumeBot')
        await channel.resumeBot(requireBotId(body))
        return { ok: true, value: view(channel) }
      }
      if (endpoint === 'bot/options') {
        requireHub(channel, 'settingsOptions')
        return { ok: true, value: { ...view(channel), options: await channel.settingsOptions() } }
      }
      if (endpoint === 'bot/settings') {
        requireHub(channel, 'updateBotSettings')
        const patch = {}
        for (const k of ['persona', 'model', 'preset']) if (k in body) patch[k] = body[k]
        await channel.updateBotSettings(requireBotId(body), patch)
        return { ok: true, value: view(channel) }
      }
      if (endpoint === 'bot/new-chat') {
        requireHub(channel, 'startNewChat')
        const peer = typeof body.peer === 'string' ? body.peer.trim() : ''
        if (!peer) throw new Error('缺少 peer')
        const result = await channel.startNewChat(requireBotId(body), peer)
        return { ok: true, value: { ...view(channel), newChat: result } }
      }
      if (endpoint === 'bot/delete') {
        requireHub(channel, 'deleteBot')
        await channel.deleteBot(requireBotId(body))
        return { ok: true, value: view(channel) }
      }
      throw new Error(`未知微信 RPC 端点：${endpoint}`)
    } catch (error) {
      return errorEnvelope(error)
    }
  }
}

const MAX_BODY_BYTES = 64 * 1024
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/

function readBody(req, limit) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy?.(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * 与 DSH Connection RPC 线协议兼容的 HTTP 路由（POST {CHANNEL}/{endpoint}，JSON client-request → server-response）。
 * 先过 connection.admit（Host/Origin 围栏 + 浏览器会话 Cookie），未通过直接 401/403。
 */
export function createWeixinHttpRoute(connection, handler) {
  return {
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      const admission = connection.admit(req)
      if (!admission || 'rejection' in admission) {
        const status = admission?.rejection ?? 403
        res.writeHead(status)
        res.end(status === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      const endpoint = pathname.startsWith(`${CHANNEL}/`) ? pathname.slice(CHANNEL.length + 1) : ''
      if (req.method !== 'POST' || !endpoint || endpoint.split('/').some((seg) => !ENDPOINT_SEGMENT.test(seg) || seg === '.' || seg === '..')) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        res.writeHead(415)
        res.end('content type must be application/json')
        return
      }
      let message
      try {
        message = JSON.parse(await readBody(req, MAX_BODY_BYTES))
      } catch (error) {
        res.writeHead(error?.status ?? 400)
        res.end(error?.status === 413 ? 'body too large' : 'body is not JSON')
        return
      }
      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
      if (message?.type !== 'client-request' || typeof message.rpcId !== 'string' || typeof message.method !== 'string') {
        sendJson(res, 200, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} } } })
        return
      }
      if (message.method !== endpoint) {
        sendJson(res, 200, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'gateway/bad-request', message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`, details: {} } } })
        return
      }
      const result = await handler(endpoint, message.payload ?? {})
      sendJson(res, 200, { type: 'server-response', rpcId, result })
    },
  }
}

/**
 * 注册抽屉 RPC。优先 connection.rpc.handle；DSH 0.2.0-rc.2 中该方法在服务自身上下文里读取 webServer，
 * 外部插件调用必抛「cannot get property "webServer" without inject」（实测），此时退回到插件自己用
 * webServer 注册同协议的前缀路由，鉴权仍由 connection.admit 完成。
 * @returns 释放函数
 */
export function registerWeixinTransport(ctx, channel, log: (line: string) => void = () => {}) {
  const handler = createWeixinRpcHandler(channel)
  const rpc = ctx.connection?.rpc
  if (rpc) {
    try {
      const registered = rpc.handle(CHANNEL, handler)
      log('抽屉 RPC 已通过 connection.rpc.handle 注册')
      return typeof registered === 'function' ? registered : () => Promise.resolve(registered).then((dispose) => dispose?.())
    } catch (error) {
      log(`connection.rpc.handle 不可用（${error?.message ?? error}），改用插件自有路由`)
    }
  }
  if (!ctx.webServer || !ctx.connection) throw new Error('缺少 webServer / connection 服务，无法注册微信抽屉 RPC')
  return ctx.webServer.register(createWeixinHttpRoute(ctx.connection, handler))
}
