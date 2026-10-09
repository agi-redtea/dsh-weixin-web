// @ts-nocheck
/**
 * 「微信」工作区分组、会话标题、原文消息来源、启动对账。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WeixinChannel } from '../src/index.mjs'
import { WeixinWorkspace, defaultBotName, weixinSessionTitle, waitForService, applySessionTitle, idTail } from '../src/workspace.mjs'

/** 模拟 dsh-workspace：create 对同一路径幂等、新建的排最前、attach 校验目录存在。 */
function fakeRegistry({ existing = [], archived = [] } = {}) {
  const items = existing.map((w) => ({ ...w, sessionIds: [...(w.sessionIds ?? [])] }))
  const reg = {
    archivedSessionIds: archived,
    calls: [],
    list: () => items.map((w) => entity(w)),
    async create(p, title) {
      reg.calls.push(['create', p, title])
      if (!fs.statSync(p).isDirectory()) throw new Error('not a dir')
      let w = items.find((x) => x.path === p)
      if (!w) { w = { id: `ws-${items.length + 1}`, path: p, title, sessionIds: [] }; items.unshift(w) }
      return entity(w)
    },
    async insertBefore(id, before) {
      reg.calls.push(['insertBefore', id, before])
      const i = items.findIndex((x) => x.id === id); const [w] = items.splice(i, 1)
      items.splice(items.findIndex((x) => x.id === before), 0, w)
    },
    items,
  }
  function entity(w) {
    return {
      id: w.id, path: w.path, title: w.title,
      get sessionIds() { return [...w.sessionIds] },
      async attachSession(sid) { reg.calls.push(['attach', sid]); if (!w.sessionIds.includes(sid)) w.sessionIds.unshift(sid) },
    }
  }
  return reg
}

function fakeTitles() {
  const titles = new Map()
  return { titles, renames: [], get: (s) => (titles.has(s.id) ? { title: titles.get(s.id) } : undefined), rename(s, t) { this.renames.push([s.id, t]); titles.set(s.id, t) } }
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wx-ws-'))

test('默认机器人名与会话标题', () => {
  assert.equal(idTail('abcdef123@im.bot'), 'f123')
  assert.equal(defaultBotName('abcdef123@im.bot'), '微信机器人 f123')
  assert.equal(defaultBotName(undefined), '微信机器人')
  assert.equal(weixinSessionTitle('小助手', 'o9xyz7788@im.wechat'), '微信·小助手')
  assert.equal(weixinSessionTitle('小助手', 'o9xyz7788@im.wechat', true), '微信·小助手·7788')
})

test('waitForService 默认不等待；显式超时时等到服务就绪', async () => {
  let ready
  const ctx = { get: (n) => (n === 'x' ? ready : undefined) }
  assert.equal(await waitForService(ctx, 'x'), undefined)
  let slept = 0
  const got = await waitForService(ctx, 'x', { timeoutMs: 10_000, intervalMs: 1, sleep: async () => { slept += 1; if (slept === 3) ready = { ok: 1 } } })
  assert.deepEqual(got, { ok: 1 })
})

test('「微信」工作区：目录不存在会先创建；新建后排第一；已存在则复用并挪到第一', async () => {
  const cwd = path.join(tmpDir(), 'nested', 'workspace')
  const reg = fakeRegistry({ existing: [{ id: 'other', path: '/x', title: 'x' }] })
  const logs = []
  const ws = new WeixinWorkspace({ get: (n) => (n === 'workspaceRegistry' ? reg : undefined) }, cwd, (l) => logs.push(l))
  const a = await ws.ensure()
  assert.ok(fs.statSync(cwd).isDirectory())
  assert.equal(a.title, '微信')
  assert.equal(reg.items[0].id, a.id)
  assert.ok(logs.some((l) => l.includes('已创建「微信」工作区')))
  // 用户把别的工作区挪到前面（或新建了工作区）：下次 ensure 会把「微信」放回第一
  reg.items.unshift(reg.items.splice(1, 1)[0])
  const b = await ws.ensure()
  assert.equal(b.id, a.id)
  assert.equal(reg.items[0].id, a.id)
  assert.equal(logs.filter((l) => l.includes('已创建')).length, 1)
})

test('attach：幂等；已归档会话不挂；宿主拒绝时只提示一次；没有工作区服务时静默降级', async () => {
  const cwd = tmpDir()
  const reg = fakeRegistry({ archived: ['s-arch'] })
  const logs = []
  const ws = new WeixinWorkspace({ get: (n) => (n === 'workspaceRegistry' ? reg : undefined) }, cwd, (l) => logs.push(l))
  assert.equal(await ws.attach('s1'), true)
  assert.equal(await ws.attach('s1'), true)
  assert.equal(reg.calls.filter((c) => c[0] === 'attach').length, 1)
  assert.equal(await ws.attach('s-arch'), false)
  const w = reg.items[0]
  const orig = reg.create
  reg.create = async (...a) => { const e = await orig(...a); e.attachSession = async () => { throw new Error('cwd mismatch') }; return e }
  assert.equal(await ws.attach('s-old'), false)
  assert.equal(await ws.attach('s-old'), false)
  assert.equal(logs.filter((l) => l.includes('cwd mismatch')).length, 1)
  assert.ok(w)

  const none = new WeixinWorkspace({ get: () => undefined }, cwd, () => {})
  assert.equal(await none.attach('s1'), false)
})

test('applySessionTitle：一致时不重复写；没有标题服务时跳过', async () => {
  const t = fakeTitles()
  const ctx = { get: (n) => (n === 'sessionTitle' ? t : undefined) }
  const s = { id: 's1' }
  assert.equal(await applySessionTitle(ctx, s, '微信·A'), true)
  assert.equal(await applySessionTitle(ctx, s, '微信·A'), false)
  assert.deepEqual(t.renames, [['s1', '微信·A']])
  assert.equal(await applySessionTitle({ get: () => undefined }, s, '微信·A'), false)
})

function makeChannel({ creds = null, sessionMap = {}, services = {}, agents } = {}) {
  // 构造时不给凭据（否则构造函数会真的启动 iLink 长轮询），构造后再挂上
  const store = { loadCredentials: () => null, loadSessionMap: () => ({ ...sessionMap }), loadBuf: () => '', saveBuf() {}, saveSessionMap() {}, saveCredentials() {} }
  const ctx = { on: () => {}, get: (n) => services[n], logger: { info() {}, warn() {} }, agents }
  const ch = new WeixinChannel(ctx, { cwd: services.__cwd ?? tmpDir(), replyMode: 'full', replyTimeoutMs: 60_000, maxChunk: 1500, sendIntervalMs: 0 }, store)
  ch.logSink = () => {}
  ch.creds = creds
  ch.composeSetup = async () => async () => {}
  return ch
}

const agentOf = (id) => ({ id, session: { id }, followup() {} })

test('新建会话：先归组、钉标题，再返回给 followup；出现第二个对话方时补尾号', async () => {
  const reg = fakeRegistry()
  const titles = fakeTitles()
  let n = 0
  const ch = makeChannel({
    creds: { bot_token: 't', ilink_bot_id: 'bot00a1b2@im.bot' },
    services: { workspaceRegistry: reg, sessionTitle: titles },
    agents: { get: (id) => created.get(id), create: async ({ sessionId }) => { n += 1; const a = agentOf(sessionId); created.set(sessionId, a); return { agent: a } } },
  })
  const created = new Map()
  const a = await ch.ensureAgentFor('peerAAAA1111@im.wechat')
  assert.deepEqual(titles.renames.map((r) => r[1]), ['微信·微信机器人 a1b2'])
  assert.ok(reg.items[0].sessionIds.includes(a.id))
  const b = await ch.ensureAgentFor('peerBBBB2222@im.wechat')
  assert.equal(titles.titles.get(b.id), '微信·微信机器人 a1b2·2222')
  assert.equal(titles.titles.get(a.id), '微信·微信机器人 a1b2·1111')
  assert.equal(n, 2)
  // 绑定时起的名字优先
  ch.creds.name = '客服一号'
  await ch.refreshTitles()
  assert.equal(titles.titles.get(a.id), '微信·客服一号·1111')
})

test('入站消息 source：kind=user + 渠道/对方/机器人归因，正文是原文', async () => {
  const ch = makeChannel({ creds: { bot_token: 't', ilink_bot_id: 'b1@im.bot' } })
  let got
  ch.getTypingTicket = async () => ''
  ch.sendReply = async () => true
  ch.ensureAgentFor = async () => ({ id: 'S', followup(m) { got = m; throw new Error('stop') } })
  await ch.handleInbound({ from: 'u1@im.wechat', to: 'b1@im.bot', contextToken: 'c', text: '原文 hello', hasText: true })
  assert.deepEqual(got.source, { kind: 'user', channel: 'dsh-weixin-web', peer: 'u1@im.wechat', bot: 'b1@im.bot' })
  assert.deepEqual(got.content, [{ type: 'text', text: '原文 hello' }])
})

test('启动对账：恢复未归档的已映射会话并归组+设标题；跳过已归档；不新建会话', async () => {
  const reg = fakeRegistry({ archived: ['s-arch'] })
  const titles = fakeTitles()
  const resumed = []
  const ch = makeChannel({
    creds: { bot_token: 't', ilink_bot_id: 'xx99zz@im.bot' },
    sessionMap: { 'u1@im.wechat': 's-live', 'u2@im.wechat': 's-arch' },
    services: { workspaceRegistry: reg, sessionTitle: titles },
    agents: { get: () => undefined, resume: async ({ resumeSessionId }) => { resumed.push(resumeSessionId); return { agent: agentOf(resumeSessionId) } }, create: async () => { throw new Error('should not create') } },
  })
  await ch.reconcile({ waitMs: 0 })
  assert.deepEqual(resumed, ['s-live'])
  assert.ok(reg.items[0].sessionIds.includes('s-live'))
  assert.equal(titles.titles.get('s-live'), '微信·微信机器人 99zz·u1')
})
