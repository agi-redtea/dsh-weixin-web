// @ts-nocheck
/** 启动时与 DSH 抢同一会话写句柄：等待已有代理，不跳过、不新建。 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { WeixinChannel, isWriterHeldError } from '../src/index.mjs'

function held() {
  const err = new Error('session "session-a" is already owned by an active write handle')
  err.name = 'SessionAlreadyOwnedError'
  return err
}

function make({ get, resume, create, session }) {
  const logs = []
  const store = { loadCredentials: () => null, loadSessionMap: () => ({ 'u@im.wechat': 'session-a' }), loadBuf: () => '', saveBuf() {}, saveSessionMap() {}, saveCredentials() {} }
  const ctx = {
    on: () => {},
    get: () => undefined,
    logger: { info() {}, warn() {} },
    agents: { get, resume, create },
  }
  const ch = new WeixinChannel(ctx, { cwd: '/tmp', replyMode: 'full', replyTimeoutMs: 1000, maxChunk: 100, sendIntervalMs: 0 }, store)
  ch.logSink = () => {}
  ch.pushLog = (l) => logs.push(l)
  ch.sleep = async () => {}
  ch.writerHeldAttempts = 4
  ch.composeSetup = async () => async () => {}
  ch.sessionMap = { 'u@im.wechat': 'session-a' }
  if (session) ch.seedActivityFromSession = (userId, agent) => { logs.push(['seed', userId, !!agent?.session]) }
  return { ch, logs }
}

const agent = { id: 'session-a', session: { id: 'session-a', snapshotEvents: () => [] }, followup() {} }

test('isWriterHeldError：名字、code 与文案都认，其它错误不认', () => {
  assert.equal(isWriterHeldError(held()), true)
  assert.equal(isWriterHeldError({ code: 'session/writer-held', message: 'x' }), true)
  assert.equal(isWriterHeldError(new Error('disk full')), false)
  assert.equal(isWriterHeldError(null), false)
})

test('写句柄竞争：resume 连续失败后等到已注册的代理，不调用 create', async () => {
  let resumes = 0
  let created = 0
  const { ch, logs } = make({
    get: () => (resumes >= 3 ? agent : undefined),
    resume: async () => { resumes += 1; throw held() },
    create: async () => { created += 1 },
  })
  const got = await ch.ensureAgentFor('u@im.wechat')
  assert.equal(got, agent)
  assert.equal(resumes, 3)
  assert.equal(created, 0)
  assert.equal(ch.sessionMap['u@im.wechat'], 'session-a')
  assert.ok(logs.some((l) => String(l).includes('不新建')))
})

test('写句柄一直被占用：到次数后抛错，绝不新建会话', async () => {
  let created = 0
  const { ch } = make({
    get: () => undefined,
    resume: async () => { throw held() },
    create: async () => { created += 1; return { agent } },
  })
  await assert.rejects(() => ch.ensureAgentFor('u@im.wechat'), /already owned/)
  assert.equal(created, 0)
  assert.equal(ch.sessionMap['u@im.wechat'], 'session-a')
})

test('resume 返回 { error: writer-held } 与抛错同样等待', async () => {
  let n = 0
  const { ch } = make({
    get: () => (n >= 2 ? agent : undefined),
    resume: async () => { n += 1; return { error: { code: 'session/writer-held', message: 'held' } } },
    create: async () => { throw new Error('no') },
  })
  assert.equal(await ch.ensureAgentFor('u@im.wechat'), agent)
})

test('其它恢复失败仍新建会话（原行为）', async () => {
  let created = 0
  const fresh = { id: 'session-new', session: { id: 'session-new' } }
  const { ch } = make({
    get: (id) => (id === 'session-new' ? fresh : undefined),
    resume: async () => { throw new Error('not found') },
    create: async ({ sessionId }) => { created += 1; fresh.id = sessionId; fresh.session.id = sessionId; return { agent: fresh } },
  })
  const got = await ch.ensureAgentFor('u@im.wechat')
  assert.equal(created, 1)
  assert.equal(got.id.startsWith('session-'), true)
  assert.notEqual(ch.sessionMap['u@im.wechat'], 'session-a')
})

test('启动对账：写句柄竞争解除后补上预览，不记「处理失败」', async () => {
  let resumes = 0
  const events = [{ type: 'assistant/message', time: 5, data: { message: { content: [{ type: 'text', text: '历史里的最后一句' }] } } }]
  const live = { id: 'session-a', session: { id: 'session-a', snapshotEvents: () => events } }
  const { ch, logs } = make({
    get: () => (resumes >= 2 ? live : undefined),
    resume: async () => { resumes += 1; throw held() },
    create: async () => { throw new Error('no') },
  })
  ch.seedActivityFromSession = WeixinChannel.prototype.seedActivityFromSession
  await ch.reconcile({ waitMs: 0 })
  assert.equal(ch.contactActivity.get('u@im.wechat')?.preview, '历史里的最后一句')
  assert.equal(logs.some((l) => String(l).includes('处理失败')), false)
  assert.equal(logs.filter((l) => String(l).includes('写句柄正被占用')).length, 1)
})
