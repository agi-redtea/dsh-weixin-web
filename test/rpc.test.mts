// @ts-nocheck
/** 抽屉 RPC：联系人视图与插件自有 HTTP 路由（DSH Connection RPC 线协议兼容）。 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { contactDisplayName, contactsView, createWeixinHttpRoute, createWeixinRpcHandler, registerWeixinTransport } from '../src/rpc.mjs'

function fakeReq({ method = 'POST', url = '/dsh-weixin-web/status', body = '', contentType = 'application/json' } = {}) {
  const req = new EventEmitter()
  Object.assign(req, { method, url, headers: { 'content-type': contentType } })
  setImmediate(() => { if (body) req.emit('data', Buffer.from(body)); req.emit('end') })
  return req
}
function fakeRes() {
  const res = { status: 0, headers: {}, body: '' }
  res.writeHead = (status, headers = {}) => { res.status = status; res.headers = headers }
  res.end = (body = '') => { res.body = String(body) }
  return res
}

test('contactDisplayName：取 id 本地部分末 6 位作兜底名', () => {
  assert.equal(contactDisplayName('o9cq807dznGkTbwKZl3Q0b@im.wechat'), '微信用户 Zl3Q0b')
  assert.equal(contactDisplayName(''), '微信用户')
})

test('contactsView：合并最近消息并按活动时间倒序', () => {
  const activity = new Map([['b@im.wechat', { lastMessageAt: 200, preview: '在吗', direction: 'inbound' }]])
  const out = contactsView({ 'a@im.wechat': 's1', 'b@im.wechat': 's2' }, activity)
  assert.deepEqual(out.map((c) => c.id), ['b@im.wechat', 'a@im.wechat'])
  assert.equal(out[0].preview, '在吗')
  assert.equal(out[1].preview, '')
  assert.equal(out[1].lastMessageAt, null)
})

test('HTTP 路由：未通过 connection.admit 直接 401', async () => {
  const route = createWeixinHttpRoute({ admit: () => ({ rejection: 401 }) }, async () => ({ ok: true, value: {} }))
  const res = fakeRes()
  await route.handler(fakeReq({ body: '{}' }), res)
  assert.equal(res.status, 401)
})

test('HTTP 路由：client-request → server-response，回显 rpcId 并透传 payload', async () => {
  let seen = null
  const route = createWeixinHttpRoute({ admit: () => ({ peer: {} }) }, async (endpoint, payload) => { seen = { endpoint, payload }; return { ok: true, value: { hello: 1 } } })
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/dsh-weixin-web')
  const res = fakeRes()
  await route.handler(fakeReq({ url: '/dsh-weixin-web/login/verify', body: JSON.stringify({ type: 'client-request', rpcId: 'r-1', method: 'login/verify', payload: { code: '42' } }) }), res)
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), { type: 'server-response', rpcId: 'r-1', result: { ok: true, value: { hello: 1 } } })
  assert.deepEqual(seen, { endpoint: 'login/verify', payload: { code: '42' } })
})

test('HTTP 路由：method 与路径不一致 / 非 POST / 非 JSON', async () => {
  const route = createWeixinHttpRoute({ admit: () => ({ peer: {} }) }, async () => ({ ok: true, value: {} }))
  let res = fakeRes()
  await route.handler(fakeReq({ body: JSON.stringify({ type: 'client-request', rpcId: 'r-2', method: 'logout', payload: {} }) }), res)
  assert.equal(JSON.parse(res.body).result.ok, false)
  res = fakeRes()
  await route.handler(fakeReq({ method: 'GET' }), res)
  assert.equal(res.status, 404)
  res = fakeRes()
  await route.handler(fakeReq({ body: 'x', contentType: 'text/plain' }), res)
  assert.equal(res.status, 415)
})

test('registerWeixinTransport：rpc.handle 抛错（DSH 0.2.0-rc.2 行为）时退回 webServer 自有路由', () => {
  const routes = []
  const logs = []
  const ctx = {
    connection: { rpc: { handle: () => { throw new Error('cannot get property "webServer" without inject') } }, admit: () => ({ peer: {} }) },
    webServer: { register: (route) => { routes.push(route); return () => routes.splice(routes.indexOf(route), 1) } },
  }
  const dispose = registerWeixinTransport(ctx, { statusView: () => ({}) }, (l) => logs.push(l))
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/dsh-weixin-web')
  assert.match(logs.join('\n'), /改用插件自有路由/)
  dispose()
  assert.equal(routes.length, 0)
})

test('registerWeixinTransport：rpc.handle 可用时直接使用', () => {
  let handled = null
  const ctx = { connection: { rpc: { handle: (channel) => { handled = channel; return () => {} } } }, webServer: { register: () => { throw new Error('不应调用') } } }
  registerWeixinTransport(ctx, {})
  assert.equal(handled, '/dsh-weixin-web')
})

test('机器人管理端点：bot/rename|pause|resume|delete 调用 hub 并返回最新视图；缺 botId 或单通道时报错', async () => {
  const calls = []
  const hub = {
    login: null,
    contactActivity: new Map(),
    statusView: () => ({ login: { active: false }, sessionMap: {}, bots: [] }),
    renameBot: async (id, name) => { calls.push(['rename', id, name]) },
    pauseBot: async (id) => { calls.push(['pause', id]) },
    resumeBot: (id) => { calls.push(['resume', id]) },
    deleteBot: async (id) => { calls.push(['delete', id]) },
  }
  const handle = createWeixinRpcHandler(hub)
  for (const [endpoint, payload] of [['bot/rename', { botId: 'a', name: '家里' }], ['bot/pause', { botId: 'a' }], ['bot/resume', { botId: 'a' }], ['bot/delete', { botId: 'a' }]]) {
    const r = await handle(endpoint, payload)
    assert.equal(r.ok, true, endpoint)
    assert.deepEqual(r.value.bots, [])
  }
  assert.deepEqual(calls, [['rename', 'a', '家里'], ['pause', 'a'], ['resume', 'a'], ['delete', 'a']])
  const missing = await handle('bot/pause', {})
  assert.equal(missing.ok, false)
  assert.match(missing.error.message, /缺少 botId/)
  const single = createWeixinRpcHandler({ statusView: () => ({ login: { active: false } }), contactActivity: new Map() })
  assert.match((await single('bot/delete', { botId: 'a' })).error.message, /不支持多机器人/)
})
