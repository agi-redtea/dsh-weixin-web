// @ts-nocheck
/** 发文件（PR G）：CDN 加密上传、消息条目、通道 sendFile/pushFile、多机器人路由、send_weixin_file / push_weixin 工具、路径限制。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDecipheriv, createHash } from 'node:crypto'
import { WeixinChannel, registerPushTool, registerSendFileTool } from '../src/index.mjs'
import { WeixinHub } from '../src/hub.mjs'
import { createStore } from '../src/creds.mjs'
import { resolveSendableFile } from '../src/files.mjs'
import {
  ILinkError, aesEcbPaddedSize, buildMediaItem, cdnUploadUrl, encryptAesEcb, outboundKind,
  sendMessage, uploadMedia, uploadToCdn, CDN_BASE_URL, UPLOAD_MEDIA_TYPE,
} from '../src/ilink.mjs'

WeixinChannel.prototype.startMonitor = async function () { this.monitorRunning = true }
const DEAD = 'http://127.0.0.1:9'
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wx-send-'))
const dec = (buf, key) => { const d = createDecipheriv('aes-128-ecb', key, null); return Buffer.concat([d.update(buf), d.final()]) }
const resp = (status, headers = {}) => ({ status, ok: status === 200, headers: new Headers(headers), text: async () => '' })

/* ------------------------------ ilink ------------------------------ */

test('加密与填充长度；按扩展名决定发送类型', () => {
  const key = Buffer.alloc(16, 7)
  for (const n of [0, 1, 15, 16, 17, 1000]) assert.equal(encryptAesEcb(Buffer.alloc(n), key).length, aesEcbPaddedSize(n))
  assert.equal(outboundKind('a.PNG'), 'image')
  assert.equal(outboundKind('b.jpeg'), 'image')
  assert.equal(outboundKind('c.mp4'), 'video')
  assert.equal(outboundKind('d.pdf'), 'file')
  assert.equal(outboundKind('noext'), 'file')
})

test('cdnUploadUrl：默认优先 upload_full_url；配置 cdnBaseUrl 时强制走它', () => {
  assert.equal(cdnUploadUrl({ uploadParam: 'u p', filekey: 'fk' }), `${CDN_BASE_URL}/upload?encrypted_query_param=u%20p&filekey=fk`)
  assert.equal(cdnUploadUrl({ uploadParam: 'u', uploadFullUrl: 'https://real/up', filekey: 'fk' }), 'https://real/up')
  assert.equal(cdnUploadUrl({ uploadParam: 'u', uploadFullUrl: 'https://real/up', filekey: 'fk', cdnBaseUrl: 'http://127.0.0.1:3990/c2c/', forceBase: true }), 'http://127.0.0.1:3990/c2c/upload?encrypted_query_param=u&filekey=fk')
  assert.throws(() => cdnUploadUrl({ filekey: 'fk' }), /没有返回上传参数/)
})

test('uploadToCdn：5xx 重试后成功；4xx 立即失败；缺下载参数按失败重试', async () => {
  let calls = 0
  const flaky = async () => (++calls < 3 ? resp(502) : resp(200, { 'x-encrypted-param': 'dl-1' }))
  assert.equal(await uploadToCdn({ url: 'http://x', ciphertext: Buffer.alloc(16), fetchImpl: flaky, retryDelayMs: 0 }), 'dl-1')
  assert.equal(calls, 3)

  calls = 0
  const reject = async () => { calls++; return resp(403, { 'x-error-message': 'bad sign' }) }
  await assert.rejects(uploadToCdn({ url: 'http://x', ciphertext: Buffer.alloc(16), fetchImpl: reject, retryDelayMs: 0 }), /HTTP 403: bad sign/)
  assert.equal(calls, 1)

  calls = 0
  const noHeader = async () => { calls++; return resp(200) }
  await assert.rejects(uploadToCdn({ url: 'http://x', ciphertext: Buffer.alloc(16), fetchImpl: noHeader, retryDelayMs: 0 }), /x-encrypted-param/)
  assert.equal(calls, 3)
})

test('uploadMedia：getuploadurl 参数正确，上传的密文能用同一密钥解出原文', async () => {
  const plain = Buffer.from('彩排要发的文件内容 1234567890')
  let body = null
  const post = async (req) => { body = req.body; assert.equal(req.endpoint, 'ilink/bot/getuploadurl'); return { ret: 0, upload_param: 'up-1', upload_full_url: 'https://real.invalid/up' } }
  let posted = null
  const fetchImpl = async (url, init) => { posted = { url, data: Buffer.from(init.body) }; return resp(200, { 'x-encrypted-param': 'dl-9' }) }
  const r = await uploadMedia({ baseUrl: 'http://ilink', token: 't', to: 'u@im.wechat', data: plain, mediaType: UPLOAD_MEDIA_TYPE.FILE, cdnBaseUrl: 'http://127.0.0.1:3990/c2c', forceBase: true, fetchImpl, post, retryDelayMs: 0 })
  assert.equal(body.media_type, 3)
  assert.equal(body.to_user_id, 'u@im.wechat')
  assert.equal(body.rawsize, plain.length)
  assert.equal(body.rawfilemd5, createHash('md5').update(plain).digest('hex'))
  assert.equal(body.filesize, aesEcbPaddedSize(plain.length))
  assert.equal(body.no_need_thumb, true)
  assert.match(body.aeskey, /^[0-9a-f]{32}$/)
  assert.match(body.filekey, /^[0-9a-f]{32}$/)
  assert.ok(posted.url.startsWith('http://127.0.0.1:3990/c2c/upload?encrypted_query_param=up-1&filekey='), '强制走配置的 CDN，不用 upload_full_url')
  assert.deepEqual(dec(posted.data, Buffer.from(body.aeskey, 'hex')), plain)
  assert.deepEqual(r, { downloadParam: 'dl-9', aeskeyHex: body.aeskey, plainSize: plain.length, cipherSize: aesEcbPaddedSize(plain.length) })
})

test('buildMediaItem：图片/视频/文件条目字段与官方插件一致', () => {
  const up = { downloadParam: 'dl', aeskeyHex: '00112233445566778899aabbccddeeff', plainSize: 10, cipherSize: 16 }
  const media = { encrypt_query_param: 'dl', aes_key: Buffer.from(up.aeskeyHex).toString('base64'), encrypt_type: 1 }
  assert.deepEqual(buildMediaItem('image', up), { type: 2, image_item: { media, mid_size: 16 } })
  assert.deepEqual(buildMediaItem('video', up), { type: 5, video_item: { media, video_size: 16 } })
  assert.deepEqual(buildMediaItem('file', up, 'a.pdf'), { type: 4, file_item: { media, file_name: 'a.pdf', len: '10' } })
})

test('sendMessage：传 items 时发媒体条目', async () => {
  let body = null
  await sendMessage({ baseUrl: 'http://x', token: 't', to: 'u', items: [{ type: 4, file_item: {} }], contextToken: 'c', post: async (r) => { body = r.body; return { ret: 0 } } })
  assert.deepEqual(body.msg.item_list, [{ type: 4, file_item: {} }])
  assert.equal(body.msg.context_token, 'c')
})

/* ------------------------------ 通道 ------------------------------ */

function makeChannel(config = {}) {
  const store = { loadCredentials: () => ({ bot_token: 'tok', baseurl: 'http://ilink' }), loadSessionMap: () => ({}), loadBuf: () => '', saveBuf: () => {}, saveSessionMap: () => {}, saveCredentials: () => {} }
  const ch = new WeixinChannel({ on: () => {}, get: () => undefined, logger: console }, { cwd: '/tmp', replyMode: 'full', replyTimeoutMs: 60_000, maxChunk: 1500, sendIntervalMs: 0, ...config }, store)
  ch.logSink = () => {}
  ch.order = []
  ch.sendReply = async (to, _c, text) => { ch.order.push(['text', to, text]); return true }
  ch.uploads = []
  ch.uploadMedia = async (args) => { ch.uploads.push(args); return { downloadParam: 'dl-1', aeskeyHex: '00'.repeat(16), plainSize: args.data.length, cipherSize: aesEcbPaddedSize(args.data.length) } }
  ch.sendItem = async (to, token, item) => { ch.order.push(['item', to, token, item.type]) }
  return ch
}

test('sendFile：先发说明文字，再上传并发媒体条目（带最新 context_token），记录最近消息', async () => {
  const ch = makeChannel({ cdnBaseUrl: 'http://127.0.0.1:3990/c2c' })
  ch.contextTokens.set('u@im.wechat', 'ctx-new')
  const r = await ch.sendFile('u@im.wechat', { data: Buffer.from('png?'), name: 'chart.png', caption: '图表如下' })
  assert.deepEqual(r, { kind: 'image', name: 'chart.png', bytes: 4 })
  assert.deepEqual(ch.order, [['text', 'u@im.wechat', '图表如下'], ['item', 'u@im.wechat', 'ctx-new', 2]])
  assert.equal(ch.uploads[0].mediaType, UPLOAD_MEDIA_TYPE.IMAGE)
  assert.equal(ch.uploads[0].to, 'u@im.wechat')
  assert.equal(ch.uploads[0].cdnBaseUrl, 'http://127.0.0.1:3990/c2c')
  assert.equal(ch.uploads[0].forceBase, true)
  assert.equal(ch.contactActivity.get('u@im.wechat').preview, '图表如下 [图片]')
})

test('sendFile：被拒时不带 context_token 重试一次；登录过期不重试', async () => {
  const ch = makeChannel()
  let n = 0
  ch.sendItem = async (to, token) => { n++; ch.order.push(['item', token]); if (n === 1) throw new ILinkError('sendmessage ret=-1') }
  await ch.sendFile('u', { data: Buffer.from('x'), name: 'a.pdf' }, 'ctx-old')
  assert.deepEqual(ch.order, [['item', 'ctx-old'], ['item', undefined]])

  const ch2 = makeChannel()
  ch2.sendItem = async () => { throw Object.assign(new ILinkError('expired'), { errcode: -14 }) }
  await assert.rejects(ch2.sendFile('u', { data: Buffer.from('x'), name: 'a.pdf' }, 'c'), /重新扫码/)
  assert.match(ch2.status.lastSendError.message, /重新扫码/)
})

test('sendFile：超过大小上限 / 空文件 / 未登录 直接拒绝，不上传', async () => {
  const ch = makeChannel({ maxMediaBytes: 8 })
  await assert.rejects(ch.sendFile('u', { data: Buffer.alloc(9), name: 'a.bin' }), /超过/)
  await assert.rejects(ch.sendFile('u', { data: Buffer.alloc(0), name: 'a.bin' }), /空的/)
  ch.creds = null
  await assert.rejects(ch.sendFile('u', { data: Buffer.alloc(1), name: 'a.bin' }), /未登录/)
  assert.equal(ch.uploads.length, 0)
})

test('pushFile：不支持广播；失败时返回 failed 与原因', async () => {
  const ch = makeChannel()
  await assert.rejects(ch.pushFile('all', { data: Buffer.from('x'), name: 'a' }), /不支持广播/)
  ch.uploadMedia = async () => { throw new Error('CDN 上传被拒 HTTP 403') }
  const r = await ch.pushFile('u', { data: Buffer.from('x'), name: 'a.txt' })
  assert.deepEqual(r, { sent: 0, failed: 1, targets: ['u'], error: 'CDN 上传被拒 HTTP 403' })
})

test('hub.pushFile：按对话方选机器人，bot 参数指定，all 拒绝', async () => {
  const dir = tmpDir()
  const store = createStore(dir)
  const ctx = { on: () => () => {}, get: () => undefined, logger: { info() {}, warn() {} } }
  const cfg = { cwd: path.join(dir, 'ws'), replyMode: 'full', replyTimeoutMs: 60_000, maxChunk: 1500, sendIntervalMs: 0 }
  const hub = new WeixinHub(ctx, cfg, store, { createChannel: (s, o) => { const c = new WeixinChannel(ctx, cfg, s, o); c.logSink = () => {}; return c } })
  hub.logSink = () => {}
  hub.applyCredentials({ bot_token: 'tok-1', baseurl: DEAD, ilink_bot_id: 'bot1@im.bot', ilink_user_id: 's1@im.wechat', loggedInAt: 1 })
  hub.applyCredentials({ bot_token: 'tok-2', baseurl: DEAD, ilink_bot_id: 'bot2@im.bot', ilink_user_id: 's2@im.wechat', loggedInAt: 2 })
  hub.channel('bot2@im.bot').sessionMap = { 'peerB@im.wechat': 'session-b' }
  const calls = []
  for (const [id, c] of hub.channels) c.pushFile = async (to, file) => { calls.push([id, to, file.name]); return { sent: 1, failed: 0, targets: [to] } }
  await hub.pushFile('peerB@im.wechat', { name: 'a.pdf' })
  await hub.pushFile('peerB@im.wechat', { name: 'b.pdf' }, 'bot1@im.bot')
  assert.deepEqual(calls, [['bot2@im.bot', 'peerB@im.wechat', 'a.pdf'], ['bot1@im.bot', 'peerB@im.wechat', 'b.pdf']])
  await assert.rejects(hub.pushFile('all', { name: 'x' }), /不支持广播/)
  await assert.rejects(hub.pushFile('u', { name: 'x' }, 'nobot'), /未找到机器人/)
})

/* ------------------------------ 路径限制 ------------------------------ */

test('resolveSendableFile：工作目录/附件目录内的文件可发；../、符号链接跳出、目录、超限、不存在都拒绝', async () => {
  const dir = tmpDir()
  const cwd = path.join(dir, 'ws'); const att = path.join(dir, 'attachments'); const outside = path.join(dir, 'secret')
  for (const d of [cwd, att, outside]) fs.mkdirSync(d)
  fs.writeFileSync(path.join(cwd, 'report.pdf'), 'pdf')
  fs.writeFileSync(path.join(att, 'img.png'), 'png')
  fs.writeFileSync(path.join(outside, 'key.txt'), 'secret')
  fs.writeFileSync(path.join(cwd, 'big.bin'), Buffer.alloc(20))
  fs.symlinkSync(path.join(outside, 'key.txt'), path.join(cwd, 'link.txt'))
  const opts = { cwd, roots: [cwd, att], maxBytes: 10 }
  assert.deepEqual(await resolveSendableFile('report.pdf', opts), { path: fs.realpathSync(path.join(cwd, 'report.pdf')), name: 'report.pdf', size: 3 })
  assert.equal((await resolveSendableFile(path.join(att, 'img.png'), opts)).name, 'img.png')
  await assert.rejects(resolveSendableFile('../secret/key.txt', opts), /只能发送/)
  await assert.rejects(resolveSendableFile('link.txt', opts), /只能发送/)
  await assert.rejects(resolveSendableFile('.', opts), /不是普通文件/)
  await assert.rejects(resolveSendableFile('big.bin', opts), /超过/)
  await assert.rejects(resolveSendableFile('nope.txt', opts), /不存在/)
  await assert.rejects(resolveSendableFile('', opts), /缺少 path/)
})

/* ------------------------------ 工具 ------------------------------ */

function toolFixture() {
  const dir = tmpDir()
  const cwd = path.join(dir, 'ws')
  fs.mkdirSync(cwd)
  fs.writeFileSync(path.join(cwd, 'out.csv'), 'a,b\n1,2\n')
  const outside = path.join(dir, 'outside.txt')
  fs.writeFileSync(outside, 'not allowed')
  const calls = []
  const target = {
    ownerOfSession: (sid) => (sid === 'session-wx' ? { botId: 'bot2@im.bot', userId: 'peer@im.wechat' } : undefined),
    pushFile: async (to, file, bot) => { calls.push({ to, name: file.name, caption: file.caption, bot, data: String(file.data) }); return { sent: 1, failed: 0, targets: [to], kind: 'file', name: file.name, bytes: file.data.length } },
    push: async (to, text, bot) => { calls.push({ to, text, bot }); return { sent: 1, failed: 0, targets: [to] } },
  }
  const tools = {}
  const ctx = { tools: { register: (t) => { tools[t.name] = t } } }
  const opts = { cwd, maxBytes: 1024, attachmentsRoot: path.join(dir, 'attachments') }
  registerPushTool(ctx, target, opts)
  registerSendFileTool(ctx, target, opts)
  const exec = (sid = 'session-wx') => ({ agent: { id: sid, session: { header: { cwd } } } })
  return { tools, calls, exec, cwd, outside }
}

test('send_weixin_file：默认发给当前微信会话的用户（用该会话的机器人），读取的是工作目录里的文件', async () => {
  const { tools, calls, exec } = toolFixture()
  const out = await tools.send_weixin_file.execute({ path: 'out.csv', caption: '数据' }, exec())
  assert.deepEqual(out, { sent: 1, kind: 'file', name: 'out.csv', bytes: 8, to: 'peer@im.wechat' })
  assert.deepEqual(calls[0], { to: 'peer@im.wechat', name: 'out.csv', caption: '数据', bot: 'bot2@im.bot', data: 'a,b\n1,2\n' })
  assert.match(tools.send_weixin_file.output.render({}, out)[0].text, /已发到微信：文件「out\.csv」/)
})

test('send_weixin_file：非微信会话需要 to；不支持广播；路径越界拒绝；发送失败报错', async () => {
  const { tools, exec, calls, outside } = toolFixture()
  await assert.rejects(tools.send_weixin_file.execute({ path: 'out.csv' }, exec('session-web')), /不是微信会话/)
  await assert.rejects(tools.send_weixin_file.execute({ path: 'out.csv', to: 'all' }, exec()), /不支持广播/)
  await assert.rejects(tools.send_weixin_file.execute({ path: outside }, exec()), /只能发送/)
  await tools.send_weixin_file.execute({ path: 'out.csv', to: 'other@im.wechat' }, exec('session-web'))
  assert.equal(calls.at(-1).to, 'other@im.wechat')
  const { exec: e2 } = toolFixture()
  const failing = { ownerOfSession: () => ({ userId: 'p' }), pushFile: async () => ({ sent: 0, failed: 1, targets: ['p'], error: 'CDN 上传被拒' }) }
  const reg = {}
  registerSendFileTool({ tools: { register: (t) => { reg[t.name] = t } } }, failing, { cwd: e2().agent.session.header.cwd })
  await assert.rejects(reg.send_weixin_file.execute({ path: 'out.csv' }, e2()), /发送失败：CDN 上传被拒/)
})

test('push_weixin：带 file 时发文件（text 作说明），不能广播；不带 file 时行为不变', async () => {
  const { tools, calls, exec } = toolFixture()
  assert.ok(tools.push_weixin.parameters.properties.file)
  await tools.push_weixin.execute({ text: '日报', file: 'out.csv' }, exec())
  assert.deepEqual(calls[0], { to: 'peer@im.wechat', name: 'out.csv', caption: '日报', bot: 'bot2@im.bot', data: 'a,b\n1,2\n' })
  await assert.rejects(tools.push_weixin.execute({ text: 'x', file: 'out.csv', to: 'all' }, exec()), /不支持广播/)
  await assert.rejects(tools.push_weixin.execute({ text: 'x', file: 'out.csv' }, exec('session-web')), /不支持广播/)
  await tools.push_weixin.execute({ text: '纯文本' }, exec('session-web'))
  assert.deepEqual(calls.at(-1), { to: 'all', text: '纯文本', bot: undefined })
})
