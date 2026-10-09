// @ts-nocheck
/**
 * 多机器人：旧数据迁移、新增/重新登录、上限、改名、暂停/恢复、解绑、汇总视图、推送路由、扫码登录全流程（本地模拟 iLink）。
 * 不访问真实 iLink：startMonitor 打桩；notifyStop 指向本机不可达端口。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { WeixinChannel, registerPushTool } from '../src/index.mjs'
import { WeixinHub, MAX_BOTS, UNBOUND_KEY } from '../src/hub.mjs'
import { createStore } from '../src/creds.mjs'
import { startLogin } from '../src/login.mjs'

const DEAD = 'http://127.0.0.1:9'
WeixinChannel.prototype.startMonitor = async function () {
  this.monitorRunning = true
  this.startCalls = (this.startCalls ?? 0) + 1
  this.startedWithBuf = this.buf
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wx-hub-'))
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))

function makeCtx(services = {}) {
  const ctx = {
    listeners: 0,
    removed: 0,
    on() { ctx.listeners += 1; return () => { ctx.removed += 1 } },
    get: (n) => services[n],
    logger: { info() {}, warn() {} },
    agents: services.agents,
  }
  return ctx
}

function makeHub(dir, { services = {}, config = {} } = {}) {
  const ctx = makeCtx(services)
  const cfg = { cwd: path.join(dir, 'workspace'), replyMode: 'full', replyTimeoutMs: 60_000, maxChunk: 1500, sendIntervalMs: 0, ...config }
  const store = createStore(dir)
  const hub = new WeixinHub(ctx, cfg, store, {
    createChannel: (s, o) => { const ch = new WeixinChannel(ctx, cfg, s, o); ch.logSink = () => {}; return ch },
  })
  hub.logSink = () => {}
  return { hub, ctx, store }
}

function writeLegacy(dir, { creds = true, map = { 'peerA1234@im.wechat': 'session-a' }, buf = 'legacy-buf' } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  if (creds) fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ baseurl: DEAD, bot_token: 'tok-legacy', ilink_bot_id: 'botlegacy9a7f@im.bot', ilink_user_id: 'scanner1@im.wechat', loggedInAt: 1000 }))
  fs.writeFileSync(path.join(dir, 'session-map.json'), JSON.stringify(map))
  fs.writeFileSync(path.join(dir, 'updates-buf.json'), JSON.stringify({ buf }))
}

const cred = (n, extra = {}) => ({ bot_token: `tok-${n}`, baseurl: DEAD, ilink_bot_id: `bot${n}@im.bot`, ilink_user_id: `scanner${n}@im.wechat`, loggedInAt: Date.now(), ...extra })

test('迁移：旧版单机器人凭据/会话映射/游标搬到 v2，旧文件原样保留，不重复迁移', async () => {
  const dir = tmpDir()
  writeLegacy(dir)
  const before = fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8')
  const { hub } = makeHub(dir)
  const bots = readJson(path.join(dir, 'bots.json'))
  assert.equal(bots.version, 2)
  assert.equal(bots.bots.length, 1)
  assert.equal(bots.bots[0].id, 'botlegacy9a7f@im.bot')
  assert.equal(bots.bots[0].legacy, true)
  assert.equal(bots.bots[0].enabled, true)
  assert.equal((fs.statSync(path.join(dir, 'bots.json')).mode & 0o777), 0o600)
  assert.deepEqual(readJson(path.join(dir, 'session-map.v2.json')), { 'botlegacy9a7f@im.bot': { 'peerA1234@im.wechat': 'session-a' } })
  assert.equal(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'), before)
  const ch = hub.channel('botlegacy9a7f@im.bot')
  assert.equal(ch.startCalls, 1, '迁移后无需重新扫码即开始轮询')
  assert.equal(ch.startedWithBuf, 'legacy-buf', '游标接续')
  assert.deepEqual(ch.sessionMap, { 'peerA1234@im.wechat': 'session-a' })
  assert.equal(ch.botName(), '微信机器人 9a7f')
  // 旧版机器人：游标/映射同步写回旧文件（回滚兼容），凭据文件不动
  ch.store.saveBuf('next-buf')
  assert.equal(readJson(path.join(dir, 'updates-buf.json')).buf, 'next-buf')
  assert.equal(hub.store.loadBotBuf('botlegacy9a7f@im.bot'), 'next-buf')
  // 再次启动：不再迁移（不会被旧文件覆盖）
  fs.writeFileSync(path.join(dir, 'session-map.json'), JSON.stringify({ x: 'y' }))
  const { hub: hub2 } = makeHub(dir)
  assert.deepEqual(hub2.channel('botlegacy9a7f@im.bot').sessionMap, { 'peerA1234@im.wechat': 'session-a' })
  assert.equal(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'), before)
})

test('迁移：旧版已登出但有会话 → 第一个新绑定的机器人接手', () => {
  const dir = tmpDir()
  writeLegacy(dir, { creds: false })
  const { hub } = makeHub(dir)
  assert.equal(hub.bots.length, 0)
  assert.deepEqual(Object.keys(hub.maps), [UNBOUND_KEY])
  const r = hub.applyCredentials(cred(1))
  assert.equal(r.isNew, true)
  assert.deepEqual(hub.channel(r.botId).sessionMap, { 'peerA1234@im.wechat': 'session-a' })
  assert.equal(hub.maps[UNBOUND_KEY], undefined)
})

test('扫码确认：新微信号新增机器人；同一机器人/同一扫码人视为重新登录，名字与会话保留；超过上限报错', async () => {
  const dir = tmpDir()
  writeLegacy(dir)
  const { hub } = makeHub(dir)
  const r1 = hub.applyCredentials(cred(2))
  assert.deepEqual(r1, { botId: 'bot2@im.bot', isNew: true })
  assert.equal(hub.channel(r1.botId).startCalls, 1)
  assert.equal(hub.bots.length, 2)
  assert.equal(hub.channel(r1.botId).store.loadBuf(), '')
  // 新机器人不写旧文件
  hub.channel(r1.botId).store.saveBuf('b2')
  assert.notEqual(readJson(path.join(dir, 'updates-buf.json')).buf, 'b2')

  await hub.renameBot('bot2@im.bot', '工作号')
  const r2 = hub.applyCredentials(cred(2, { bot_token: 'tok-2-new' }))
  assert.deepEqual(r2, { botId: 'bot2@im.bot', isNew: false })
  assert.equal(hub.bot('bot2@im.bot').bot_token, 'tok-2-new')
  assert.equal(hub.channel('bot2@im.bot').botName(), '工作号')
  // 同一扫码微信号拿到新的机器人 id：沿用原记录（会话映射键不变）
  const r3 = hub.applyCredentials(cred(9, { ilink_user_id: 'scanner1@im.wechat' }))
  assert.deepEqual(r3, { botId: 'botlegacy9a7f@im.bot', isNew: false })
  assert.equal(hub.bot('botlegacy9a7f@im.bot').ilink_bot_id, 'bot9@im.bot')
  assert.equal(hub.bots.length, 2)
  assert.deepEqual(hub.localTokenList().sort(), ['tok-2-new', 'tok-9'])

  for (let i = 3; hub.bots.length < MAX_BOTS; i++) hub.applyCredentials(cred(i))
  assert.throws(() => hub.applyCredentials(cred(99)), /最多绑定 10 个/)
  assert.equal(readJson(path.join(dir, 'bots.json')).bots.length, MAX_BOTS)
})

test('改名：持久化并刷新该机器人所有会话标题；空名恢复默认', async () => {
  const dir = tmpDir()
  writeLegacy(dir, { map: { 'peerA1234@im.wechat': 'session-a', 'peerB5678@im.wechat': 'session-b' } })
  const renames = []
  const titles = new Map()
  const sessionTitle = { get: (s) => (titles.has(s.id) ? { title: titles.get(s.id) } : undefined), rename: (s, t) => { renames.push([s.id, t]); titles.set(s.id, t) } }
  const agents = { get: (id) => ({ id, session: { id } }) }
  const { hub } = makeHub(dir, { services: { sessionTitle, agents } })
  await hub.renameBot('botlegacy9a7f@im.bot', '  家里  的助手 ')
  assert.equal(readJson(path.join(dir, 'bots.json')).bots[0].name, '家里 的助手')
  assert.deepEqual(renames.sort(), [['session-a', '微信·家里 的助手·1234'], ['session-b', '微信·家里 的助手·5678']])
  await hub.renameBot('botlegacy9a7f@im.bot', '')
  assert.equal(hub.channel('botlegacy9a7f@im.bot').botName(), '微信机器人 9a7f')
  assert.equal(titles.get('session-a'), '微信·微信机器人 9a7f·1234')
  await assert.rejects(hub.renameBot('nope', 'x'), /未找到机器人/)
})

test('暂停/恢复：停轮询并持久化 enabled，恢复时从保存的游标继续；暂停状态跨重启保留', async () => {
  const dir = tmpDir()
  writeLegacy(dir)
  const { hub } = makeHub(dir)
  const id = 'botlegacy9a7f@im.bot'
  const ch = hub.channel(id)
  await hub.pauseBot(id)
  assert.equal(ch.paused, true)
  assert.equal(ch.monitorRunning, false)
  assert.equal(ch.monitorAbort.signal.aborted, false, '换了新的 AbortController')
  assert.equal(readJson(path.join(dir, 'bots.json')).bots[0].enabled, false)
  const v = hub.statusView()
  assert.equal(v.bots[0].health, 'paused')
  assert.equal(v.bots[0].connected, false)
  assert.equal(v.health, 'paused')

  const { hub: restarted } = makeHub(dir)
  assert.equal(restarted.channel(id).paused, true)
  assert.equal(restarted.channel(id).startCalls, undefined, '暂停的机器人重启后不轮询')

  ch.buf = 'buf-at-pause'
  hub.resumeBot(id)
  assert.equal(ch.paused, false)
  assert.equal(ch.startCalls, 2)
  assert.equal(ch.startedWithBuf, 'buf-at-pause')
  assert.equal(readJson(path.join(dir, 'bots.json')).bots[0].enabled, true)
  assert.equal(hub.statusView().bots[0].health, 'ok')
})

test('解绑：停轮询、摘监听、删本地凭据与游标；会话映射保留，重新绑定同一机器人可接上', async () => {
  const dir = tmpDir()
  writeLegacy(dir)
  const { hub, ctx } = makeHub(dir)
  hub.applyCredentials(cred(2))
  hub.channel('bot2@im.bot').store.saveSessionMap({ 'peerC@im.wechat': 'session-c' })
  hub.channel('bot2@im.bot').store.saveBuf('b2')
  const bufFile = path.join(dir, 'bufs', 'bot2_im.bot.json')
  assert.ok(fs.existsSync(bufFile))
  const removedBefore = ctx.removed
  const ch = hub.channel('bot2@im.bot')
  await hub.deleteBot('bot2@im.bot')
  assert.equal(ch.stopped, true)
  assert.equal(ctx.removed - removedBefore, 2, 'session/event 与 dispose 监听都已摘掉')
  assert.equal(hub.channel('bot2@im.bot'), undefined)
  assert.deepEqual(readJson(path.join(dir, 'bots.json')).bots.map((b) => b.id), ['botlegacy9a7f@im.bot'])
  assert.equal(fs.existsSync(bufFile), false)
  assert.deepEqual(readJson(path.join(dir, 'session-map.v2.json'))['bot2@im.bot'], { 'peerC@im.wechat': 'session-c' })
  hub.applyCredentials(cred(2))
  assert.deepEqual(hub.channel('bot2@im.bot').sessionMap, { 'peerC@im.wechat': 'session-c' })
  // 旧抽屉「退出登录」= 全部解绑，旧凭据文件仍不动
  const legacyCreds = fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8')
  await hub.clearCredentials()
  assert.equal(hub.bots.length, 0)
  assert.equal(hub.statusView().health, 'logged_out')
  assert.equal(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'), legacyCreds)
})

test('汇总视图：保留旧版字段并列出每个机器人', async () => {
  const dir = tmpDir()
  writeLegacy(dir)
  const { hub } = makeHub(dir)
  hub.applyCredentials(cred(2))
  await hub.renameBot('bot2@im.bot', '工作号')
  hub.channel('bot2@im.bot').store.saveSessionMap({ 'peerC@im.wechat': 'session-c' })
  hub.channel('bot2@im.bot').sessionMap = { 'peerC@im.wechat': 'session-c' }
  const v = hub.statusView()
  assert.equal(v.connected, true)
  assert.equal(v.health, 'ok')
  assert.equal(v.maxBots, 10)
  assert.deepEqual(Object.keys(v.sessionMap).sort(), ['peerA1234@im.wechat', 'peerC@im.wechat'])
  assert.deepEqual(v.bots.map((b) => [b.name, b.customName, b.idTail, b.enabled, b.contacts.length]), [
    ['微信机器人 9a7f', '', '9a7f', true, 1],
    ['工作号', '工作号', 'bot2', true, 1],
  ])
  assert.equal(JSON.stringify(v).includes('tok-'), false, '视图不含 bot_token')
})

test('推送路由：按对话方选机器人；bot 参数指定；all 汇总；push_weixin 缺省发给会话所属机器人', async () => {
  const dir = tmpDir()
  writeLegacy(dir)
  const { hub } = makeHub(dir)
  hub.applyCredentials(cred(2))
  hub.channel('bot2@im.bot').sessionMap = { 'peerC@im.wechat': 'session-c' }
  const sent = []
  for (const [id, ch] of hub.channels) ch.sendReply = async (to, _ctx, text) => { sent.push([id, to, text]); return true }
  await hub.push('peerC@im.wechat', 'hi')
  await hub.push('peerA1234@im.wechat', 'yo')
  await hub.push('peerA1234@im.wechat', 'via', '工作号').catch(() => {})
  await hub.renameBot('bot2@im.bot', '工作号')
  await hub.push('peerA1234@im.wechat', 'via2', '工作号')
  const all = await hub.push('all', 'broadcast')
  assert.deepEqual(all, { sent: 2, failed: 0, targets: ['peerA1234@im.wechat', 'peerC@im.wechat'] })
  assert.deepEqual(sent.slice(0, 2), [['bot2@im.bot', 'peerC@im.wechat', 'hi'], ['botlegacy9a7f@im.bot', 'peerA1234@im.wechat', 'yo']])
  assert.deepEqual(sent.find((s) => s[2] === 'via2'), ['bot2@im.bot', 'peerA1234@im.wechat', 'via2'])
  await assert.rejects(hub.push('x', 'y', 'nobot'), /未找到机器人/)

  let tool
  registerPushTool({ tools: { register: (t) => { tool = t } } }, hub)
  assert.ok(tool.parameters.properties.bot)
  await tool.execute({ text: 'scheduled' }, { agent: { id: 'session-c' } })
  assert.deepEqual(sent.at(-1), ['bot2@im.bot', 'peerC@im.wechat', 'scheduled'])
})

test('扫码登录全流程（本地模拟 iLink）：带上全部已有 token，确认后新增机器人并开始轮询', async () => {
  const seen = { qr: [], status: 0 }
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    res.setHeader('content-type', 'application/json')
    if (req.url.startsWith('/ilink/bot/get_bot_qrcode')) { seen.qr.push(JSON.parse(body).local_token_list); return res.end(JSON.stringify({ ret: 0, qrcode: 'qr-1', qrcode_img_content: 'https://mock.invalid/qr-1' })) }
    if (req.url.startsWith('/ilink/bot/get_qrcode_status')) { seen.status += 1; return res.end(JSON.stringify({ status: 'confirmed', bot_token: 'tok-new', ilink_bot_id: 'botnew4321@im.bot', ilink_user_id: 'scannerNew@im.wechat', baseurl: DEAD })) }
    res.statusCode = 404; res.end('{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const dir = tmpDir()
    writeLegacy(dir)
    const { hub } = makeHub(dir, { config: { loginBaseUrl: `http://127.0.0.1:${server.address().port}` } })
    await startLogin(hub)
    for (let i = 0; i < 50 && hub.login.status !== 'confirmed'; i++) await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(seen.qr, [['tok-legacy']])
    assert.equal(hub.login.status, 'confirmed')
    assert.equal(hub.loginView().botId, 'botnew4321@im.bot')
    assert.equal(hub.loginView().isNew, true)
    assert.equal(hub.bots.length, 2)
    assert.equal(hub.channel('botnew4321@im.bot').startCalls, 1)
    assert.equal(hub.statusView().bots[1].name, '微信机器人 4321')
  } finally {
    server.close()
  }
})
