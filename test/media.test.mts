// @ts-nocheck
/** 收媒体（PR F）：多图、文件、视频+封面、语音兜底、引用消息、CDN 地址与大小上限。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { WeixinChannel } from '../src/index.mjs'
import { normalizeInboundMessages, downloadMediaBytes, cdnDownloadUrl, MediaTooLargeError, CDN_BASE_URL } from '../src/ilink.mjs'

const FROM = 'wechat-user-1@im.wechat'
const media = (p, key = '') => ({ encrypt_query_param: p, aes_key: key })

function makeChannel(config = {}) {
  const store = { loadCredentials: () => null, loadSessionMap: () => ({}), loadBuf: () => '', saveBuf: () => {}, saveSessionMap: () => {}, saveCredentials: () => {} }
  const ch = new WeixinChannel({ on: () => {}, get: () => undefined, logger: console }, {
    cwd: '/tmp', stateDir: '', replyMode: 'full', replyTimeoutMs: 60_000, maxChunk: 1500, sendIntervalMs: 0, ...config,
  }, store)
  ch.sent = []
  ch.sendReply = async (to, _ctx, text) => { ch.sent.push({ to, text }); return true }
  ch.getTypingTicket = async () => ''
  ch.downloads = []
  ch.downloadImageBytes = async (args) => { ch.downloads.push(args); return Buffer.from(`bytes:${args.encryptQueryParam}`) }
  ch.saved = { images: [], files: [] }
  ch.ctx.attachments = {
    imageLimits: { maxImageBytes: 10 * 1024 * 1024 },
    saveImage: async (input) => { ch.saved.images.push(input); return { attachmentId: `img-${ch.saved.images.length}` } },
    saveFile: async (input) => { ch.saved.files.push(input); return { attachmentId: `file-${ch.saved.files.length}`, name: input.name, bytes: input.data.length } },
  }
  ch.capture = () => new Promise((resolve) => {
    ch.ensureAgentFor = async () => ({ id: 'session-m', options: {}, followup(u) { resolve(u); throw new Error('capture') } })
  })
  return ch
}

function inbound(items, extra = {}) {
  return normalizeInboundMessages({ msgs: [{ from_user_id: FROM, to_user_id: 'bot@im.bot', context_token: 'c1', item_list: items, ...extra }] })[0]
}

/* ------------------------------ 解析 ------------------------------ */

test('normalize：多张图片全部保留，首张仍放在 image 字段', () => {
  const m = inbound([
    { type: 2, image_item: { media: media('p1'), aeskey: '00112233445566778899aabbccddeeff' } },
    { type: 2, image_item: { media: media('p2', 'k2') } },
  ])
  assert.equal(m.images.length, 2)
  assert.equal(m.image.encrypt_query_param, 'p1')
  assert.equal(m.images[1].aesKey, 'k2')
})

test('normalize：文件（名字、大小）与视频（大小、封面）', () => {
  const m = inbound([
    { type: 4, file_item: { media: media('f1', 'kf'), file_name: '报告.pdf', len: '1234' } },
    { type: 5, video_item: { media: media('v1', 'kv'), video_size: 999, thumb_media: media('t1', 'kt') } },
  ])
  assert.deepEqual(m.files[0], { kind: 'file', encrypt_query_param: 'f1', full_url: '', aesKey: 'kf', name: '报告.pdf', size: 1234 })
  assert.equal(m.videos[0].size, 999)
  assert.deepEqual(m.videos[0].thumb, { encrypt_query_param: 't1', full_url: '', aesKey: 'kt' })
})

test('normalize：视频封面没有自己的密钥时沿用视频密钥；没有可下载媒体的条目忽略', () => {
  const m = inbound([
    { type: 5, video_item: { media: media('v1', 'kv'), thumb_media: { encrypt_query_param: 't1' } } },
    { type: 4, file_item: { file_name: 'x' } },
  ])
  assert.equal(m.videos[0].thumb.aesKey, 'kv')
  assert.equal(m.files.length, 0)
  assert.deepEqual(m.nonTextTypes, [5, 4])
})

test('normalize：语音有转写进 voiceText，转写为空也保留语音条目', () => {
  const a = inbound([{ type: 3, voice_item: { text: '明天几点', playtime: 3000 } }])
  assert.equal(a.voiceText, '明天几点')
  assert.equal(a.hasText, true)
  const b = inbound([{ type: 3, voice_item: { media: media('vo'), text: '' } }])
  assert.equal(b.voiceText, '')
  assert.equal(b.hasText, false)
  assert.equal(b.voices.length, 1)
  assert.equal(b.voices[0].text, '')
})

test('normalize：引用文本 / 引用图片', () => {
  const a = inbound([{ type: 1, text_item: { text: '这个怎么理解' }, ref_msg: { title: '量子纠缠是什么', message_item: { type: 1, text_item: { text: '量子纠缠是什么' } } } }])
  assert.deepEqual(a.quote, { text: '量子纠缠是什么', media: null })
  const b = inbound([{ type: 1, text_item: { text: '图里是啥' }, ref_msg: { title: '张三', message_item: { type: 2, image_item: { media: media('qi', 'kq') } } } }])
  assert.equal(b.quote.text, '张三 | [图片]')
  assert.equal(b.quote.media.kind, 'image')
  assert.equal(b.quote.media.encrypt_query_param, 'qi')
})

/* ------------------------------ 下载 ------------------------------ */

test('cdnDownloadUrl：默认用服务端 full_url；配置了 cdnBaseUrl 时强制只走它', () => {
  assert.equal(cdnDownloadUrl({ encryptQueryParam: 'a b', fullUrl: '' }), `${CDN_BASE_URL}/download?encrypted_query_param=a%20b`)
  assert.equal(cdnDownloadUrl({ encryptQueryParam: 'a', fullUrl: 'https://real/x' }), 'https://real/x')
  assert.equal(cdnDownloadUrl({ encryptQueryParam: 'a', fullUrl: 'https://real/x', cdnBaseUrl: 'http://127.0.0.1:3990/c2c/', forceBase: true }), 'http://127.0.0.1:3990/c2c/download?encrypted_query_param=a')
})

test('downloadMediaBytes：解密；content-length 超限直接放弃；流式超限中止', async () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const plain = Buffer.from('hello media bytes')
  const c = createCipheriv('aes-128-ecb', key, null)
  const enc = Buffer.concat([c.update(plain), c.final()])
  const ok = async () => new Response(enc)
  assert.deepEqual(await downloadMediaBytes({ encryptQueryParam: 'x', aesKey: key.toString('base64'), fetchImpl: ok, maxBytes: 100 }), plain)

  const declared = async () => new Response('x', { headers: { 'content-length': String(10_000) } })
  await assert.rejects(downloadMediaBytes({ encryptQueryParam: 'x', aesKey: '', fetchImpl: declared, maxBytes: 100 }), MediaTooLargeError)

  const big = async () => new Response(new ReadableStream({ pull(ctrl) { ctrl.enqueue(new Uint8Array(64)) } }))
  await assert.rejects(downloadMediaBytes({ encryptQueryParam: 'x', aesKey: '', fetchImpl: big, maxBytes: 1000 }), MediaTooLargeError)
})

/* ------------------------------ 处理 ------------------------------ */

test('handleInbound：多张图片 + 文字（看图模型）→ 文字 + 每张一个 image 块', async () => {
  const ch = makeChannel()
  ch.supportsVision = async () => true
  const got = ch.capture()
  await ch.handleInbound(inbound([
    { type: 1, text_item: { text: '比较这两张' } },
    { type: 2, image_item: { media: media('p1') } },
    { type: 2, image_item: { media: media('p2') } },
  ]))
  const u = await got
  assert.deepEqual(u.content.map((b) => b.type), ['text', 'image', 'image'])
  assert.equal(u.content[0].text, '比较这两张')
  assert.deepEqual(ch.downloads.map((d) => d.encryptQueryParam), ['p1', 'p2'])
})

test('handleInbound：图片 + 文字（不看图模型）→ 图片作为文件附件，不进视觉通道', async () => {
  const ch = makeChannel()
  ch.supportsVision = async () => false
  const got = ch.capture()
  await ch.handleInbound(inbound([{ type: 1, text_item: { text: '存一下' } }, { type: 2, image_item: { media: media('p1') } }]))
  const u = await got
  assert.deepEqual(u.content.map((b) => b.type), ['text', 'file'])
  assert.match(u.content[0].text, /当前模型不看图/)
  assert.equal(ch.saved.images.length, 0)
  assert.match(ch.saved.files[0].name, /^weixin-image-\d+\.jpg$/)
  // PNG 按实际格式命名
  const ch2 = makeChannel()
  ch2.supportsVision = async () => false
  ch2.downloadImageBytes = async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const got2 = ch2.capture()
  await ch2.handleInbound(inbound([{ type: 1, text_item: { text: '存' } }, { type: 2, image_item: { media: media('p1') } }]))
  await got2
  assert.match(ch2.saved.files[0].name, /^weixin-image-\d+\.png$/)
})

test('handleInbound：文件存为 DSH 附件（保留文件名），只发文件时给模型一句说明', async () => {
  const ch = makeChannel()
  const got = ch.capture()
  await ch.handleInbound(inbound([{ type: 4, file_item: { media: media('f1'), file_name: '报告.pdf', len: '20' } }]))
  const u = await got
  assert.deepEqual(u.content.map((b) => b.type), ['text', 'file'])
  assert.match(u.content[0].text, /发来了\[文件\] 报告\.pdf/)
  assert.equal(ch.saved.files[0].name, '报告.pdf')
  assert.equal(String(ch.saved.files[0].data), 'bytes:f1')
  assert.equal(u.content[1].attachment.name, '报告.pdf')
})

test('handleInbound：超过 20MB 的文件不下载，告诉模型未接收', async () => {
  const ch = makeChannel()
  const got = ch.capture()
  await ch.handleInbound(inbound([{ type: 4, file_item: { media: media('f1'), file_name: '大.zip', len: String(25 * 1024 * 1024) } }]))
  const u = await got
  assert.equal(ch.downloads.length, 0)
  assert.equal(u.content[1].type, 'text')
  assert.match(u.content[1].text, /大\.zip」超过 20MB，未接收/)
})

test('handleInbound：下载时发现超限 / 下载失败 → 文本提示，不崩溃', async () => {
  const ch = makeChannel()
  ch.downloadImageBytes = async (a) => { if (a.encryptQueryParam === 'big') throw new MediaTooLargeError(30e6, a.maxBytes); throw new Error('cdn down') }
  const got = ch.capture()
  await ch.handleInbound(inbound([
    { type: 4, file_item: { media: media('big'), file_name: 'a.bin' } },
    { type: 4, file_item: { media: media('bad'), file_name: 'b.bin' } },
  ]))
  const u = await got
  assert.match(u.content[1].text, /a\.bin」超过 20MB/)
  assert.match(u.content[2].text, /b\.bin」接收失败/)
})

test('handleInbound：视频存为文件；看图模型额外附上封面图', async () => {
  const ch = makeChannel()
  ch.supportsVision = async () => true
  const got = ch.capture()
  await ch.handleInbound(inbound([{ type: 5, video_item: { media: media('v1', 'kv'), thumb_media: media('t1', 'kt') } }]))
  const u = await got
  assert.deepEqual(u.content.map((b) => b.type), ['text', 'file', 'image'])
  assert.match(ch.saved.files[0].name, /^weixin-video-\d+\.mp4$/)
  assert.deepEqual(ch.downloads.map((d) => d.encryptQueryParam), ['v1', 't1'])

  const ch2 = makeChannel()
  ch2.supportsVision = async () => false
  const got2 = ch2.capture()
  await ch2.handleInbound(inbound([{ type: 5, video_item: { media: media('v1'), thumb_media: media('t1') } }]))
  assert.deepEqual((await got2).content.map((b) => b.type), ['text', 'file']) // 不看图就不下封面
  assert.deepEqual(ch2.downloads.map((d) => d.encryptQueryParam), ['v1'])
})

test('handleInbound：语音没有转写文字 → 友好提示，不跑模型', async () => {
  const ch = makeChannel()
  let ran = false
  ch.ensureAgentFor = async () => { ran = true; return { id: 's', followup() {} } }
  await ch.handleInbound(inbound([{ type: 3, voice_item: { media: media('vo'), text: '' } }]))
  assert.equal(ran, false)
  assert.equal(ch.sent.length, 1)
  assert.match(ch.sent[0].text, /没听清这段语音/)
})

test('handleInbound：不支持的条目类型提示里列出新支持的格式', async () => {
  const ch = makeChannel()
  await ch.handleInbound(inbound([{ type: 99 }]))
  assert.match(ch.sent[0].text, /文字 \/ 图片 \/ 语音 \/ 文件 \/ 视频/)
})

test('handleInbound：引用文本 → 正文前加「> 引用：…」', async () => {
  const ch = makeChannel()
  const got = ch.capture()
  await ch.handleInbound(inbound([{ type: 1, text_item: { text: '展开说说' }, ref_msg: { title: '第二点', message_item: { type: 1, text_item: { text: '第二点是缓存失效' } } } }]))
  const u = await got
  assert.equal(u.content[0].text, '> 引用：第二点 | 第二点是缓存失效\n\n展开说说')
})

test('handleInbound：引用了图片且本条没带媒体 → 下载被引用的图片', async () => {
  const ch = makeChannel()
  ch.supportsVision = async () => true
  const got = ch.capture()
  await ch.handleInbound(inbound([{ type: 1, text_item: { text: '图里是啥' }, ref_msg: { message_item: { type: 2, image_item: { media: media('qi') } } } }]))
  const u = await got
  assert.deepEqual(u.content.map((b) => b.type), ['text', 'image'])
  assert.equal(u.content[0].text, '> 引用：[图片]\n\n图里是啥')
  assert.deepEqual(ch.downloads.map((d) => d.encryptQueryParam), ['qi'])
})

test('fetchMedia：配置 cdnBaseUrl 时强制走它，并带上大小上限与媒体超时', async () => {
  const ch = makeChannel({ cdnBaseUrl: 'http://127.0.0.1:3990/c2c', maxMediaBytes: 1234 })
  await ch.fetchMedia({ encrypt_query_param: 'p', full_url: 'https://real.example/x', aesKey: 'k' })
  assert.equal(ch.downloads[0].cdnBaseUrl, 'http://127.0.0.1:3990/c2c')
  assert.equal(ch.downloads[0].forceBase, true)
  assert.equal(ch.downloads[0].maxBytes, 1234)
  const ch2 = makeChannel()
  await ch2.fetchMedia({ encrypt_query_param: 'p' })
  assert.equal(ch2.downloads[0].forceBase, false)
  assert.equal(ch2.downloads[0].maxBytes, 20 * 1024 * 1024)
})
