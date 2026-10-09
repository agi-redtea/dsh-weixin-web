// @ts-nocheck
/**
 * 长轮询可靠性：iLink 业务错误码检查、-14 会话过期 → 需要重新扫码、失败退避、connected 反映真实健康度。
 * 通过 channel.getUpdates / notifyStart / sleep 注入点驱动 startMonitor，不访问网络、不真实等待。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { WeixinChannel, pollBackoffMs, SESSION_EXPIRED_PAUSE_MS } from '../src/index.mjs'
import { getUpdates, ILinkError, isSessionExpired, assertILinkOk, SESSION_EXPIRED_ERRCODE } from '../src/ilink.mjs'

function makeChannel() {
  const store = { loadCredentials: () => null, loadSessionMap: () => ({}), loadBuf: () => '', saveBuf: () => {}, saveSessionMap: () => {}, saveCredentials: () => {} }
  const ch = new WeixinChannel({ on: () => {}, get: () => undefined, logger: console }, { replyMode: 'full', replyTimeoutMs: 60_000, maxChunk: 1500, sendIntervalMs: 0 }, store)
  ch.creds = { bot_token: 'tok', baseurl: 'https://example.invalid' }
  ch.notifyStart = async () => ({})
  return ch
}

/**
 * 按脚本驱动 startMonitor：steps 中每项是一次 getUpdates 的结果（对象=返回，Error=抛出）。
 * 每次 getUpdates / sleep 时记录状态快照；脚本跑完后停止通道。
 */
async function drive(ch, steps) {
  const sleeps = []
  const snapshots = []
  let i = 0
  ch.sleep = async (ms) => { sleeps.push(ms); snapshots.push({ at: 'sleep', ...ch.statusView() }) }
  ch.getUpdates = async () => {
    if (i > 0) snapshots.push({ at: `before#${i}`, ...ch.statusView() })
    if (i >= steps.length) { ch.stopped = true; ch.monitorAbort.abort(); return { ret: 0, msgs: [] } }
    const step = steps[i++]
    if (step instanceof Error) throw step
    return step
  }
  await ch.startMonitor()
  return { sleeps, snapshots }
}

test('assertILinkOk / getUpdates：HTTP 200 但 ret 或 errcode 非 0 时抛 ILinkError', async () => {
  assert.deepEqual(assertILinkOk('x', { ret: 0, msgs: [] }), { ret: 0, msgs: [] })
  assert.throws(() => assertILinkOk('getupdates', { ret: -1, errmsg: 'boom' }), /getupdates ret=-1/)
  await assert.rejects(
    () => getUpdates({ baseUrl: 'https://example.invalid', token: 't', post: async () => ({ errcode: -14, errmsg: 'session timeout' }) }),
    (err) => err instanceof ILinkError && err.errcode === -14 && isSessionExpired(err),
  )
  const ok = await getUpdates({ baseUrl: 'https://example.invalid', token: 't', post: async () => ({ ret: 0, msgs: [], get_updates_buf: 'b' }) })
  assert.equal(ok.get_updates_buf, 'b')
  assert.equal(SESSION_EXPIRED_ERRCODE, -14)
  assert.equal(isSessionExpired(new ILinkError('x', { ret: -14 })), true)
  assert.equal(isSessionExpired(new Error('x')), false)
})

test('errcode -14：标记 needsRelogin、connected=false、提示重新扫码，并长时间暂停而不是空转', async () => {
  const ch = makeChannel()
  const expired = new ILinkError('getupdates ret= errcode=-14 errmsg=session timeout', { errcode: -14 })
  const { sleeps, snapshots } = await drive(ch, [expired])
  assert.deepEqual(sleeps, [SESSION_EXPIRED_PAUSE_MS])
  const during = snapshots.find((s) => s.at === 'sleep')
  assert.equal(during.needsRelogin, true)
  assert.equal(during.connected, false)
  assert.equal(during.health, 'needs_relogin')
  assert.match(during.lastError, /重新扫码/)
})

test('会话过期后再次轮询成功：needsRelogin 自动清除', async () => {
  const ch = makeChannel()
  await drive(ch, [new ILinkError('x', { errcode: -14 }), { ret: 0, msgs: [] }])
  assert.equal(ch.statusView().needsRelogin, false)
  assert.equal(ch.status.lastError, null)
})

test('普通错误：指数退避（1s/2s/4s），连续 3 次失败后 connected=false，成功后恢复', async () => {
  const ch = makeChannel()
  const fail = () => new Error('fetch failed')
  const { sleeps, snapshots } = await drive(ch, [fail(), fail(), fail(), { ret: 0, msgs: [] }])
  assert.deepEqual(sleeps, [1000, 2000, 4000])
  const sleepSnaps = snapshots.filter((s) => s.at === 'sleep')
  assert.equal(sleepSnaps[0].connected, true, '单次抖动仍视为已连接（重试中）')
  assert.equal(sleepSnaps[0].health, 'retrying')
  assert.equal(sleepSnaps[0].lastError, 'fetch failed')
  assert.equal(sleepSnaps[2].connected, false, '连续 3 次失败视为不健康')
  const recovered = snapshots.find((s) => s.at === 'before#4')
  assert.equal(recovered.connected, true)
  assert.equal(recovered.failures, 0)
  assert.equal(recovered.lastError, null)
})

test('业务错误码（非 -14）也走退避，不再无间隔空转', async () => {
  const ch = makeChannel()
  const { sleeps } = await drive(ch, [new ILinkError('getupdates ret=-1', { ret: -1 }), new ILinkError('getupdates ret=-1', { ret: -1 })])
  assert.deepEqual(sleeps, [1000, 2000])
})

test('pollBackoffMs 封顶 30s', () => {
  assert.equal(pollBackoffMs(1), 1000)
  assert.equal(pollBackoffMs(5), 16000)
  assert.equal(pollBackoffMs(20), 30000)
})

test('轮询循环退出后 connected=false（之前 monitorRunning 永远为 true）', async () => {
  const ch = makeChannel()
  await drive(ch, [])
  assert.equal(ch.monitorRunning, false)
  assert.equal(ch.statusView().connected, false)
})

test('重新登录（abort 当前循环）立即结束会话过期暂停', async () => {
  const ch = makeChannel()
  let resolvedEarly = false
  ch.getUpdates = async () => { throw new ILinkError('x', { errcode: -14 }) }
  const loop = ch.startMonitor() // 使用默认的可中断 sleep（30 分钟）
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(ch.statusView().needsRelogin, true)
  ch.stopped = true
  ch.monitorAbort.abort()
  await Promise.race([loop.then(() => { resolvedEarly = true }), new Promise((r) => setTimeout(r, 500))])
  assert.equal(resolvedEarly, true, 'abort 后暂停立即结束，循环退出')
})
