// @ts-nocheck
/**
 * 按用户排队 / 多会话并发 / context_token 过期 / 发送失败可见 / turn 关联。
 * 不访问真实微信：sendChunk、handleInbound、fetch 均打桩。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { WeixinChannel } from '../src/index.mjs'
import { ILinkError, sendMessage } from '../src/ilink.mjs'

const tick = () => new Promise((r) => setTimeout(r, 0))

function makeChannel(config = {}) {
  const store = { loadCredentials: () => null, loadSessionMap: () => ({}), loadBuf: () => '', saveBuf: () => {}, saveSessionMap: () => {}, saveCredentials: () => {} }
  const cfg = { cwd: '/tmp', stateDir: '', replyMode: 'full', replyTimeoutMs: 60_000, maxChunk: 1500, sendIntervalMs: 0, ...config }
  const ch = new WeixinChannel({ on: () => {}, get: () => undefined, logger: console }, cfg, store)
  ch.creds = { bot_token: 'bot', baseurl: 'https://example.invalid' }
  return ch
}

/** 记录 sendChunk 调用；failWith(token) 返回要抛出的错误（或 undefined 表示成功）。 */
function stubChunks(ch, failWith = () => undefined) {
  const calls = []
  ch.sendChunk = async (to, token, piece) => {
    calls.push({ to, token, piece })
    const err = failWith(token, calls.length)
    if (err) throw err
  }
  return calls
}

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

const inbound = (from, text, contextToken = `ctx-${text}`) => ({ from, to: 'bot@im.bot', contextToken, text, hasText: true })

/* ------------------------------ 按用户排队 ------------------------------ */

test('同一用户串行、不同用户并行：A 的长对话不阻塞 B', async () => {
  const ch = makeChannel()
  const started = []
  const gates = new Map()
  ch.handleInbound = (msg) => {
    started.push(msg.text)
    const d = deferred()
    gates.set(msg.text, d)
    return d.promise
  }
  const a1 = ch.enqueueInbound(inbound('A@im.wechat', 'a1'))
  const b1 = ch.enqueueInbound(inbound('B@im.wechat', 'b1'))
  const a2 = ch.enqueueInbound(inbound('A@im.wechat', 'a2'))
  await tick()
  assert.deepEqual(started, ['a1', 'b1'], 'B 不必等 A；A 的第二条等第一条结束')
  gates.get('b1').resolve()
  await b1
  assert.deepEqual(started, ['a1', 'b1'])
  gates.get('a1').resolve()
  await a1
  await tick()
  assert.deepEqual(started, ['a1', 'b1', 'a2'])
  gates.get('a2').resolve()
  await a2
  await tick()
  assert.equal(ch.inboundQueues.size, 0, '队列处理完后清理')
})

test('某条消息处理抛错不会卡住该用户后续消息', async () => {
  const ch = makeChannel()
  const done = []
  ch.handleInbound = async (msg) => {
    if (msg.text === 'bad') throw new Error('kaboom')
    done.push(msg.text)
  }
  ch.enqueueInbound(inbound('A@im.wechat', 'bad'))
  await ch.enqueueInbound(inbound('A@im.wechat', 'good'))
  assert.deepEqual(done, ['good'])
  assert.ok(ch.logs.some((l) => l.includes('kaboom')))
})

test('长轮询循环不再等待整轮对话：处理中的消息不影响继续拉取', async () => {
  const ch = makeChannel()
  const never = new Promise(() => {})
  const handled = []
  ch.handleInbound = (msg) => { handled.push(msg.text); return never } // 模拟一轮对话迟迟不结束
  const origFetch = globalThis.fetch
  let polls = 0
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('getupdates')) {
      polls += 1
      if (polls >= 3) { ch.stopped = true; ch.monitorAbort.abort() }
      const msgs = polls <= 2 ? [{ from_user_id: `u${polls}@im.wechat`, to_user_id: 'bot@im.bot', context_token: `c${polls}`, item_list: [{ type: 1, text_item: { text: `m${polls}` } }] }] : []
      return new Response(JSON.stringify({ ret: 0, msgs, get_updates_buf: `b${polls}` }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }
  try {
    await Promise.race([ch.startMonitor(), new Promise((_, rej) => setTimeout(() => rej(new Error('startMonitor 被入站处理阻塞')), 2000))])
  } finally {
    globalThis.fetch = origFetch
  }
  assert.ok(polls >= 3, `继续拉取了 ${polls} 次`)
  assert.deepEqual(handled, ['m1', 'm2'])
  assert.equal(ch.contextTokens.get('u2@im.wechat'), 'c2')
})

/* ------------------------------ context_token ------------------------------ */

test('回复使用该用户最新的 context_token（上一轮期间又收到新消息）', async () => {
  const ch = makeChannel()
  ch.handleInbound = async () => {}
  await ch.enqueueInbound(inbound('A@im.wechat', 'x', 'old'))
  const calls = stubChunks(ch)
  ch.enqueueInbound(inbound('A@im.wechat', 'y', 'new'))
  assert.equal(await ch.sendReply('A@im.wechat', 'old', '回复'), true)
  assert.equal(calls[0].token, 'new')
})

test('context_token 被拒：不带 token 重试一次并成功', async () => {
  const ch = makeChannel()
  const calls = stubChunks(ch, (token) => token ? new ILinkError('sendmessage ret=-1', { ret: -1 }) : undefined)
  assert.equal(await ch.sendReply('A@im.wechat', 'stale', '你好'), true)
  assert.deepEqual(calls.map((c) => c.token), ['stale', undefined])
  assert.equal(ch.statusView().lastSendError, null)
})

test('context_token 被拒且期间收到更新的 token：换用最新 token 重试', async () => {
  const ch = makeChannel()
  const calls = stubChunks(ch, (token, n) => {
    if (n === 1) { ch.contextTokens.set('A@im.wechat', 'fresh'); return new ILinkError('sendmessage ret=-1', { ret: -1 }) }
    return undefined
  })
  assert.equal(await ch.sendReply('A@im.wechat', 'stale', '你好'), true)
  assert.deepEqual(calls.map((c) => c.token), ['stale', 'fresh'])
})

test('重试仍失败：记录 lastSendError、写日志、返回 false；之后发送成功清除', async () => {
  const ch = makeChannel()
  stubChunks(ch, () => new ILinkError('sendmessage ret=-1 errmsg=bad token', { ret: -1 }))
  assert.equal(await ch.sendReply('A@im.wechat', 'stale', '你好'), false)
  const v = ch.statusView()
  assert.equal(v.lastSendError.to, 'A@im.wechat')
  assert.match(v.lastSendError.message, /bad token/)
  assert.ok(ch.logs.some((l) => l.includes('发送失败') && l.includes('bad token')))

  stubChunks(ch)
  assert.equal(await ch.sendReply('A@im.wechat', undefined, '好了'), true)
  assert.equal(ch.statusView().lastSendError, null)
})

test('bot 登录过期（errcode -14）：不做无意义重试，提示重新扫码', async () => {
  const ch = makeChannel()
  const calls = stubChunks(ch, () => Object.assign(new ILinkError('sendmessage errcode=-14', {}), { errcode: -14 }))
  assert.equal(await ch.sendReply('A@im.wechat', 'tok', '你好'), false)
  assert.equal(calls.length, 1)
  assert.match(ch.statusView().lastSendError.message, /重新扫码/)
})

test('网络错误不触发 token 重试（交给 sendMessage 自身的重试）', async () => {
  const ch = makeChannel()
  const calls = stubChunks(ch, () => new Error('fetch failed'))
  assert.equal(await ch.sendReply('A@im.wechat', 'tok', '你好'), false)
  assert.equal(calls.length, 1)
})

test('push 带上该用户最近的 context_token', async () => {
  const ch = makeChannel()
  ch.contextTokens.set('A@im.wechat', 'recent')
  const calls = stubChunks(ch)
  const r = await ch.push('A@im.wechat', '提醒')
  assert.equal(r.sent, 1)
  assert.equal(calls[0].token, 'recent')
})

test('sendMessage：HTTP 200 但 errcode 非 0（实测 -14 session timeout）视为失败，而不是发送成功', async () => {
  await assert.rejects(
    () => sendMessage({ baseUrl: 'https://example.invalid', token: 't', to: 'u', text: 'x', post: async () => ({ errcode: -14, errmsg: 'session timeout' }), maxAttempts: 1 }),
    (err) => err instanceof ILinkError && err.errcode === -14,
  )
  const ok = await sendMessage({ baseUrl: 'https://example.invalid', token: 't', to: 'u', text: 'x', post: async () => ({ ret: 0 }) })
  assert.deepEqual(ok, { ret: 0 })
})

/* ------------------------------ turn 关联 ------------------------------ */

function pend(ch, msgId, sessionId, from = 'A@im.wechat') {
  const p = { from, contextToken: 'tok', sessionId, resolved: false, timer: null }
  p.resolve = () => { p.resolved = true }
  ch.pending.set(msgId, p)
  return p
}

function recordReplies(ch) {
  const sent = []
  ch.sendReply = async (to, token, text) => { sent.push({ to, text }); return true }
  return sent
}

test('两个会话交错进行：各自收集、各自回复（以前单一 collector 会互相覆盖）', async () => {
  const ch = makeChannel()
  const sent = recordReplies(ch)
  pend(ch, 'm-a', 'S-A', 'A@im.wechat')
  pend(ch, 'm-b', 'S-B', 'B@im.wechat')
  const ev = (sid, type, data) => ch.handleSessionEvent({ id: sid }, { type, data })
  ev('S-A', 'turn/start', { turn: 1 })
  ev('S-A', 'user/message', { id: 'm-a' })
  ev('S-B', 'turn/start', { turn: 4 })
  ev('S-B', 'user/message', { id: 'm-b' })
  ev('S-A', 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '给 A 的回复' }] } })
  ev('S-B', 'assistant/message', { turn: 4, message: { content: [{ type: 'text', text: '给 B 的回复' }] } })
  ev('S-B', 'turn/end', { turn: 4, reason: { kind: 'completed' } })
  ev('S-A', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await tick()
  assert.deepEqual(sent, [{ to: 'B@im.wechat', text: '给 B 的回复' }, { to: 'A@im.wechat', text: '给 A 的回复' }])
  assert.equal(ch.pending.size, 0)
  assert.equal(ch.collectors.size, 0)
})

test('轮次在 user/message 之前就出错（如 prepareRequest 失败）：立即回错误，不再等 15 分钟超时', async () => {
  const ch = makeChannel()
  const sent = recordReplies(ch)
  const p = pend(ch, 'm1', 'S')
  ch.handleSessionEvent({ id: 'S' }, { type: 'turn/start', data: { turn: 3 } })
  ch.handleSessionEvent({ id: 'S' }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'error', error: { message: 'No API key for provider deepseek' } } } })
  await tick()
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /No API key/)
  assert.equal(ch.pending.size, 0)
  assert.equal(p.resolved, true)
})

test('消息到达时会话已在跑别的轮次：那一轮出错不误伤，消息在下一轮正常回复', async () => {
  const ch = makeChannel()
  const sent = recordReplies(ch)
  ch.handleSessionEvent({ id: 'S' }, { type: 'turn/start', data: { turn: 4 } }) // DSH 页面里正在跑的一轮
  pend(ch, 'm1', 'S')
  ch.handleSessionEvent({ id: 'S' }, { type: 'turn/end', data: { turn: 4, reason: { kind: 'error', error: { message: '别的轮次出错' } } } })
  await tick()
  assert.equal(sent.length, 0)
  assert.equal(ch.pending.size, 1)
  ch.handleSessionEvent({ id: 'S' }, { type: 'turn/start', data: { turn: 5 } })
  ch.handleSessionEvent({ id: 'S' }, { type: 'user/message', data: { id: 'm1' } })
  ch.handleSessionEvent({ id: 'S' }, { type: 'assistant/message', data: { turn: 5, message: { content: [{ type: 'text', text: '正常回复' }] } } })
  ch.handleSessionEvent({ id: 'S' }, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
  await tick()
  assert.deepEqual(sent.map((s) => s.text), ['正常回复'])
})

test('候选轮次正常结束但没取到消息：清除候选，下一轮继续认领', async () => {
  const ch = makeChannel()
  const sent = recordReplies(ch)
  pend(ch, 'm1', 'S')
  ch.handleSessionEvent({ id: 'S' }, { type: 'turn/start', data: { turn: 1 } })
  ch.handleSessionEvent({ id: 'S' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ch.handleSessionEvent({ id: 'S' }, { type: 'turn/start', data: { turn: 2 } })
  ch.handleSessionEvent({ id: 'S' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'model down' } } } })
  await tick()
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /model down/)
})

test('user/message 带 turn 字段时以事件自带的 turn 为准', async () => {
  const ch = makeChannel()
  const sent = recordReplies(ch)
  pend(ch, 'm1', 'S')
  ch.handleSessionEvent({ id: 'S' }, { type: 'turn/start', data: { turn: 1 } })
  ch.handleSessionEvent({ id: 'S' }, { type: 'user/message', data: { id: 'm1', turn: 2 } })
  ch.handleSessionEvent({ id: 'S' }, { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'ok' }] } } })
  ch.handleSessionEvent({ id: 'S' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await tick()
  assert.deepEqual(sent.map((s) => s.text), ['ok'])
})

test('用户消息以 kind:"user" 注入（DSH 0.2 显示为普通用户气泡，不再是「收到执行请求」），带渠道归因，不是旧的 kind:"plugin"', async () => {
  const ch = makeChannel()
  recordReplies(ch)
  ch.getTypingTicket = async () => ''
  let followed
  ch.ensureAgentFor = async () => ({ id: 'S', followup(m) { followed = m; throw new Error('stop here') } })
  await ch.handleInbound(inbound('A@im.wechat', 'hi'))
  assert.equal(typeof followed.source.kind, 'string')
  assert.notEqual(followed.source.kind, 'plugin')
  assert.equal(followed.source.kind, 'user')
  assert.equal(followed.source.channel, 'dsh-weixin-web')
})
