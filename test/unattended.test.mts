// @ts-nocheck
/**
 * 无人值守会话：审批策略 never、回复超时取消轮次、插件日志进入 DSH logger。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { WeixinChannel } from '../src/index.mjs'

function makeChannel({ config = {}, services = {}, logger, agents } = {}) {
  const store = { loadCredentials: () => null, loadSessionMap: () => ({}), loadBuf: () => '', saveBuf: () => {}, saveSessionMap: () => {}, saveCredentials: () => {} }
  const log = logger ?? { info() {}, warn() {}, error() {} }
  const ctx = { on: () => {}, get: (name) => services[name], logger: log, agents }
  const cfg = { cwd: '/tmp', stateDir: '', replyMode: 'full', replyTimeoutMs: 60_000, maxChunk: 1500, sendIntervalMs: 0, ...config }
  const ch = new WeixinChannel(ctx, cfg, store)
  ch.sinkLines = []
  ch.logSink = (level, message) => ch.sinkLines.push({ level, message })
  ch.sent = []
  ch.sendReply = async (to, token, text) => { ch.sent.push({ to, text }); return true }
  ch.getTypingTicket = async () => ''
  return ch
}

function fakeApproval(initial = 'ask') {
  const policies = new Map()
  return {
    calls: [],
    effectivePolicy: (session) => policies.get(session) ?? initial,
    setPolicy(agent, policy) { this.calls.push({ id: agent.id, policy }); policies.set(agent.session, policy) },
  }
}

const fakeAgent = (id = 'session-1') => ({ id, session: { id }, followup() {}, cancelled: [], cancel(cause, opts) { this.cancelled.push({ cause, opts }) } })

test('取到已在内存中的会话时把审批策略设为 never（只设置一次）', async () => {
  const approval = fakeApproval('ask')
  const agent = fakeAgent()
  const ch = makeChannel({ services: { approval }, agents: { get: () => agent } })
  ch.sessionMap = { 'u@im.wechat': agent.id }
  assert.equal(await ch.ensureAgentFor('u@im.wechat'), agent)
  assert.equal(await ch.ensureAgentFor('u@im.wechat'), agent)
  assert.deepEqual(approval.calls, [{ id: agent.id, policy: 'never' }])
  assert.ok(ch.logs.some((l) => l.includes('审批策略设为 never')))
})

test('恢复持久化会话与新建会话同样设置审批策略', async () => {
  const approval = fakeApproval('ask')
  const resumed = fakeAgent('session-old')
  const created = fakeAgent('session-new')
  const ch = makeChannel({
    services: { approval },
    agents: { get: () => undefined, resume: async () => ({ agent: resumed }), create: async () => ({ agent: created }) },
  })
  ch.composeSetup = async () => async () => {}
  ch.sessionMap = { 'a@im.wechat': 'session-old' }
  await ch.ensureAgentFor('a@im.wechat')
  await ch.ensureAgentFor('b@im.wechat')
  assert.deepEqual(approval.calls.map((c) => c.id), ['session-old', 'session-new'])
})

test('approvalPolicy=ask 时尊重配置，不改动；没有 approval 服务或设置失败都不影响取代理', async () => {
  const approval = fakeApproval('ask')
  const agent = fakeAgent()
  const ch = makeChannel({ config: { approvalPolicy: 'ask' }, services: { approval }, agents: { get: () => agent } })
  ch.sessionMap = { 'u@im.wechat': agent.id }
  await ch.ensureAgentFor('u@im.wechat')
  assert.equal(approval.calls.length, 0)

  const ch2 = makeChannel({ agents: { get: () => agent } })
  ch2.sessionMap = { 'u@im.wechat': agent.id }
  assert.equal(await ch2.ensureAgentFor('u@im.wechat'), agent)

  const broken = { effectivePolicy: () => 'ask', setPolicy() { throw new Error('nope') } }
  const ch3 = makeChannel({ services: { approval: broken }, agents: { get: () => agent } })
  ch3.sessionMap = { 'u@im.wechat': agent.id }
  assert.equal(await ch3.ensureAgentFor('u@im.wechat'), agent)
  assert.ok(ch3.logs.some((l) => l.includes('设置审批策略失败') && l.includes('nope')))
})

test('回复超时：取消该会话当前轮次，并回「处理超时」', async () => {
  const agent = fakeAgent()
  const ch = makeChannel({ config: { replyTimeoutMs: 20 } })
  ch.ensureAgentFor = async () => agent
  await ch.handleInbound({ from: 'u@im.wechat', to: 'bot@im.bot', contextToken: 't', text: '在吗', hasText: true })
  assert.equal(agent.cancelled.length, 1)
  assert.deepEqual(agent.cancelled[0].cause, { kind: 'hook', reason: 'dsh-weixin-web: reply timeout' })
  assert.equal(ch.pending.size, 0)
  assert.match(ch.sent.at(-1).text, /处理超时/)
})

test('正常完成的轮次不会被取消', async () => {
  const agent = fakeAgent()
  const ch = makeChannel({ config: { replyTimeoutMs: 1000 } })
  agent.followup = (msg) => {
    setTimeout(() => {
      ch.handleSessionEvent({ id: agent.id }, { type: 'turn/start', data: { turn: 1 } })
      ch.handleSessionEvent({ id: agent.id }, { type: 'user/message', data: { id: msg.id } })
      ch.handleSessionEvent({ id: agent.id }, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '在的' }] } } })
      ch.handleSessionEvent({ id: agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    }, 5)
  }
  ch.ensureAgentFor = async () => agent
  await ch.handleInbound({ from: 'u@im.wechat', to: 'bot@im.bot', contextToken: 't', text: '在吗', hasText: true })
  assert.equal(agent.cancelled.length, 0)
  assert.equal(ch.sent.at(-1).text, '在的')
})

test('插件日志输出到 stdout/stderr（进入 journal）', () => {
  const ch = makeChannel()
  ch.sinkLines.length = 0
  ch.pushLog('微信通道启动（iLink 长轮询）')
  ch.pushLog('长轮询异常（1）：fetch failed')
  assert.deepEqual(ch.sinkLines, [
    { level: 'info', message: '[dsh-weixin-web] 微信通道启动（iLink 长轮询）' },
    { level: 'warn', message: '[dsh-weixin-web] 长轮询异常（1）：fetch failed' },
  ])
  ch.logSink = () => { throw new Error('EPIPE') }
  ch.pushLog('仍然记录到内存')
  assert.match(ch.logs.at(-1), /仍然记录到内存/)
})

test('插件日志同时写入 DSH logger（失败类用 warn，其余 info），logger 异常不影响通道', () => {
  const lines = { info: [], warn: [] }
  const logger = { info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m) }
  const ch = makeChannel({ logger })
  lines.info.length = 0; lines.warn.length = 0; ch.logs.length = 0 // 去掉构造时的启动日志
  ch.pushLog('微信通道启动（iLink 长轮询）')
  ch.pushLog('发送失败：boom')
  assert.deepEqual(lines.info, ['[dsh-weixin-web] 微信通道启动（iLink 长轮询）'])
  assert.deepEqual(lines.warn, ['[dsh-weixin-web] 发送失败：boom'])
  assert.equal(ch.logs.length, 2)

  const ch2 = makeChannel({ logger: { info() { throw new Error('x') } } })
  const before = ch2.logs.length
  ch2.pushLog('hello')
  assert.equal(ch2.logs.length, before + 1)
})

test('已归档的会话不再复用/恢复：新建会话并更新映射（DSH 0.2 会拒绝归档会话的每一步）', async () => {
  const live = fakeAgent('session-archived')
  const created = fakeAgent('session-fresh')
  const calls = []
  const saved = []
  const ch = makeChannel({
    services: { workspaceRegistry: { archivedSessionIds: ['session-archived'] } },
    agents: {
      get: (id) => (id === 'session-archived' ? live : undefined),
      resume: async () => { calls.push('resume'); return { agent: live } },
      create: async (opts) => { calls.push(`create:${opts.sessionId === undefined ? '' : 'id'}`); return { agent: created } },
    },
  })
  ch.store.saveSessionMap = (m) => saved.push({ ...m })
  ch.composeSetup = async () => async () => {}
  ch.sessionMap = { 'u@im.wechat': 'session-archived' }
  assert.equal(await ch.ensureAgentFor('u@im.wechat'), created)
  assert.deepEqual(calls, ['create:id'])
  assert.notEqual(ch.sessionMap['u@im.wechat'], 'session-archived')
  assert.equal(saved.length, 1)
  assert.ok(ch.logs.some((l) => l.includes('已在 DSH 中归档')))
})

test('未归档、或取不到 workspaceRegistry / 读取出错时照常复用会话', async () => {
  const agent = fakeAgent('session-1')
  for (const services of [{}, { workspaceRegistry: { archivedSessionIds: ['other'] } }, { workspaceRegistry: { get archivedSessionIds() { throw new Error('boom') } } }]) {
    const ch = makeChannel({ services, agents: { get: () => agent } })
    ch.sessionMap = { 'u@im.wechat': 'session-1' }
    assert.equal(await ch.ensureAgentFor('u@im.wechat'), agent)
  }
})
