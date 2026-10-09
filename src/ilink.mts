/**
 * iLink Bot 协议客户端（微信 ClawBot 官方通道）。
 * 服务端：https://ilinkai.weixin.qq.com，纯 HTTP/JSON。
 * 协议细节对齐腾讯官方 @tencent-weixin/openclaw-weixin 开源包。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

const ILINK_APP_ID = 'bot'
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6 // 对齐官方 2.4.6
const CHANNEL_VERSION = '2.4.6'
const DEFAULT_BOT_AGENT = 'DeepSeek Harness Weixin Channel'
const LONG_POLL_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000

export class ILinkError extends Error {
  [key: string]: any
  constructor(message, { ret, errcode, errmsg }: any = {}) {
    super(message)
    this.name = 'ILinkError'
    this.ret = ret
    this.errcode = errcode
    this.errmsg = errmsg
  }
}

/** iLink 会话过期（bot_token 失效）的错误码，与腾讯官方 openclaw-weixin 的 SESSION_EXPIRED_ERRCODE 一致。 */
export const SESSION_EXPIRED_ERRCODE = -14

/** 是否为「登录已过期，需要重新扫码」类错误。 */
export function isSessionExpired(err) {
  return err instanceof ILinkError && (err.errcode === SESSION_EXPIRED_ERRCODE || err.ret === SESSION_EXPIRED_ERRCODE)
}

/**
 * 业务层错误检查：HTTP 200 也可能带非 0 的 ret / errcode（如 -14 会话过期）。
 * 之前只看 HTTP 状态，导致过期 token 被当成「成功但无消息」，长轮询无间隔空转、面板一直显示已连接。
 */
export function assertILinkOk(endpoint, resp) {
  const ret = resp?.ret
  const errcode = resp?.errcode
  const bad = (ret !== undefined && ret !== null && ret !== 0) || (errcode !== undefined && errcode !== null && errcode !== 0)
  if (!bad) return resp
  const errmsg = resp?.errmsg ?? ''
  const parts = [endpoint]
  if (ret !== undefined && ret !== null) parts.push(`ret=${ret}`)
  if (errcode !== undefined && errcode !== null) parts.push(`errcode=${errcode}`)
  if (errmsg) parts.push(`errmsg=${errmsg}`)
  throw new ILinkError(parts.join(' '), { ret, errcode, errmsg })
}

function randomWechatUin() {
  const uint32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

function buildHeaders({ token }: any) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  }
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`
  return headers
}

function buildBaseInfo(botAgent) {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: (botAgent || DEFAULT_BOT_AGENT).slice(0, 200),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function apiPost({ baseUrl, endpoint, body, token, timeoutMs, signal }: any) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const controller = timeoutMs ? new AbortController() : undefined
  const t = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  // 组合外部中止信号（供 stop/登出打断长轮询）与超时信号
  const signals = [signal, controller?.signal].filter(Boolean)
  try {
    const res = await fetch(new URL(endpoint, base).toString(), {
      method: 'POST',
      headers: buildHeaders({ token }),
      body: JSON.stringify(body),
      ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
    })
    const raw = await res.text()
    if (!res.ok) throw new ILinkError(`${endpoint} HTTP ${res.status}: ${raw.slice(0, 200)}`)
    return JSON.parse(raw)
  } catch (err) {
    if (err instanceof ILinkError) throw err
    // 长轮询超时/被外部中止都按「无新消息」返回；循环会检查 aborted 决定是否继续
    if (err?.name === 'AbortError' && timeoutMs === LONG_POLL_TIMEOUT_MS) {
      return { ret: 0, msgs: [], get_updates_buf: body?.get_updates_buf ?? '' }
    }
    throw err
  } finally {
    if (t) clearTimeout(t)
  }
}

async function apiGet({ baseUrl, endpoint, timeoutMs }: any) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const controller = timeoutMs ? new AbortController() : undefined
  const t = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  try {
    const res = await fetch(new URL(endpoint, base).toString(), {
      method: 'GET',
      headers: {
        'iLink-App-Id': ILINK_APP_ID,
        'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
      },
      ...(controller ? { signal: controller.signal } : {}),
    })
    const raw = await res.text()
    if (!res.ok) throw new ILinkError(`${endpoint} HTTP ${res.status}: ${raw.slice(0, 200)}`)
    return JSON.parse(raw)
  } catch (err) {
    if (err instanceof ILinkError) throw err
    // 仅长轮询超时视为「尚无新状态」；网络/解析等真实错误抛给调用方，勿静默吞掉（review S7）
    if (err?.name === 'AbortError') return { status: 'wait' }
    throw err
  } finally {
    if (t) clearTimeout(t)
  }
}

/* ------------------------------ 登录 ------------------------------ */

export async function fetchQRCode({ baseUrl = DEFAULT_BASE_URL, botType = '3', localTokenList = [] }: any = {}) {
  const resp = await apiPost({
    baseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: { local_token_list: localTokenList },
    timeoutMs: API_TIMEOUT_MS,
  })
  if (resp.ret && resp.ret !== 0) {
    throw new ILinkError(`get_bot_qrcode ret=${resp.ret}`, { ret: resp.ret, errmsg: resp.errmsg })
  }
  return resp
}

export async function pollQRStatus({ baseUrl = DEFAULT_BASE_URL, qrcode, verifyCode, timeoutMs = LONG_POLL_TIMEOUT_MS }: any) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`
  return apiGet({ baseUrl, endpoint, timeoutMs })
}

/* ------------------------------ 消息 ------------------------------ */

/** 长轮询收消息。非 0 的 ret / errcode 抛 ILinkError（含 -14 会话过期）。post 为测试注入点。 */
export async function getUpdates({ baseUrl, token, buf = '', timeoutMs = LONG_POLL_TIMEOUT_MS, botAgent, signal, post = apiPost }: any) {
  const resp = await post({
    baseUrl,
    endpoint: 'ilink/bot/getupdates',
    token,
    timeoutMs,
    signal,
    body: { get_updates_buf: buf, base_info: buildBaseInfo(botAgent) },
  })
  return assertILinkOk('getupdates', resp)
}

/** 发送消息（文本或单个媒体条目）；带限流（ret=-2）指数退避重试。post/backoffBaseMs 为测试注入点（review S10）。 */
export async function sendMessage({
  baseUrl, token, to, text, items, contextToken, botAgent,
  maxAttempts = 5, onWarn,
  post = apiPost, backoffBaseMs = 1000,
}: any) {
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: randomUUID(),
      message_type: 2,
      message_state: 2,
      // items：发送媒体条目（图片/文件/视频，每次只放一个，与官方插件一致）；否则发文本
      item_list: Array.isArray(items) && items.length ? items : (text ? [{ type: 1, text_item: { text } }] : []),
      ...(contextToken ? { context_token: contextToken } : {}),
    },
    base_info: buildBaseInfo(botAgent),
  }
  let lastErr: any = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await post({
        baseUrl, endpoint: 'ilink/bot/sendmessage', token, timeoutMs: API_TIMEOUT_MS, body,
      })
      const ret = resp?.ret ?? 0
      // HTTP 200 也可能带 errcode（实测 bot_token 失效时返回 {errcode:-14,errmsg:'session timeout'}，没有 ret），
      // 以前只看 ret，会把这种失败当成发送成功。
      const errcode = resp?.errcode ?? 0
      const errmsg = resp?.errmsg ?? ''
      if (ret !== 0 || errcode !== 0) {
        const rateLimited = ret === -2 || /rate/i.test(String(errmsg))
        lastErr = Object.assign(new ILinkError(`sendmessage ret=${ret} errcode=${errcode} errmsg=${errmsg}`, { ret, errmsg }), { errcode })
        if (rateLimited && attempt < maxAttempts) {
          const wait = Math.min(2 ** attempt, 16) * backoffBaseMs
          onWarn?.(`限流（ret=${ret}），${wait / 1000}s 后重试`)
          await sleep(wait)
          continue
        }
        throw lastErr
      }
      return resp
    } catch (err) {
      if (err instanceof ILinkError) throw err
      lastErr = err
      if (attempt < maxAttempts) {
        const wait = Math.min(2 ** attempt, 16) * backoffBaseMs
        onWarn?.(`网络错误重试：${err?.message ?? err}`)
        await sleep(wait)
      }
    }
  }
  throw lastErr ?? new Error('sendMessage 重试耗尽')
}

export async function getConfig({ baseUrl, token, ilinkUserId, contextToken, botAgent }: any) {
  return apiPost({
    baseUrl,
    endpoint: 'ilink/bot/getconfig',
    token,
    timeoutMs: API_TIMEOUT_MS,
    body: {
      ilink_user_id: ilinkUserId,
      ...(contextToken ? { context_token: contextToken } : {}),
      base_info: buildBaseInfo(botAgent),
    },
  })
}

/** status: 1=开始输入 2=取消（TypingStatus）。 */
export async function sendTyping({ baseUrl, token, to, typingTicket, status, botAgent }: any) {
  return apiPost({
    baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    token,
    timeoutMs: API_TIMEOUT_MS,
    body: {
      ilink_user_id: to,
      ...(typingTicket ? { typing_ticket: typingTicket } : {}),
      status,
      base_info: buildBaseInfo(botAgent),
    },
  })
}

export async function notifyStart({ baseUrl, token, botAgent }: any) {
  return apiPost({
    baseUrl, endpoint: 'ilink/bot/msg/notifystart', token, timeoutMs: API_TIMEOUT_MS,
    body: { base_info: buildBaseInfo(botAgent) },
  })
}

export async function notifyStop({ baseUrl, token, botAgent }: any) {
  return apiPost({
    baseUrl, endpoint: 'ilink/bot/msg/notifystop', token, timeoutMs: API_TIMEOUT_MS,
    body: { base_info: buildBaseInfo(botAgent) },
  })
}

/* ------------------------------ 媒体（CDN 下载/解密） ------------------------------ */

/** 微信 CDN 域名（图片/语音/文件下载、上传），与 ilink 主站分离。 */
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** attachment 服务只收这 4 种栅格图。 */
const VALID_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

/** 从字节头嗅探图片 MIME；未识别回退 image/jpeg（微信图片基本是 JPEG）。 */
export function sniffImageMime(buf) {
  if (buf?.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf?.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf?.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif'
  if (buf?.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return 'image/jpeg'
}

/** 解析 CDN 媒体 aes_key（两种编码：base64(16 字节) 或 base64(32 位 hex 字符串)）。 */
export function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(aesKeyBase64 ?? '', 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(`aes_key 无法解析为 16 字节密钥（解码长度=${decoded.length}）`)
}

/** AES-128-ECB 解密（PKCS7，无 IV）。 */
export function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** 单个媒体（图片/文件/视频/语音）默认大小上限：20MB。 */
export const DEFAULT_MAX_MEDIA_BYTES = 20 * 1024 * 1024
/** 媒体下载超时（比普通 API 长，视频/文件可能较大）。 */
export const MEDIA_TIMEOUT_MS = 60_000

/** 超过大小上限时抛出的错误（调用方据此给用户「文件过大」提示，而不是「接收失败」）。 */
export class MediaTooLargeError extends Error {
  [key: string]: any
  constructor(bytes, maxBytes) {
    super(`媒体超过大小上限（${bytes ?? '未知'}B > ${maxBytes}B）`)
    this.name = 'MediaTooLargeError'
    this.bytes = bytes
    this.maxBytes = maxBytes
  }
}

/** 拼接 CDN 下载地址。forceBase=true（配置了 cdnBaseUrl）时忽略服务端给的 full_url，保证彩排/测试永远不碰真实 CDN。 */
export function cdnDownloadUrl({ encryptQueryParam, fullUrl, cdnBaseUrl = CDN_BASE_URL, forceBase = false }) {
  if (fullUrl && !forceBase) return fullUrl
  const base = String(cdnBaseUrl || CDN_BASE_URL).replace(/\/+$/, '')
  return `${base}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam ?? '')}`
}

/** 读取响应体，超过 limit 字节立即中止（不把超大文件整个读进内存）。 */
async function readBodyCapped(res, limit, abort) {
  const declared = Number(res.headers?.get?.('content-length') ?? NaN)
  if (limit && Number.isFinite(declared) && declared > limit) { abort?.(); throw new MediaTooLargeError(declared, limit) }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer())
    if (limit && buf.length > limit) throw new MediaTooLargeError(buf.length, limit)
    return buf
  }
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (limit && total > limit) { await reader.cancel().catch(() => {}); abort?.(); throw new MediaTooLargeError(total, limit) }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/**
 * 下载并解密 CDN 媒体（图片/文件/视频/语音），返回明文 Buffer（失败抛错）。
 * aesKey 为 base64（见 parseAesKey）；为空表示明文 CDN。maxBytes 为明文上限（0 = 不限），超限抛 MediaTooLargeError。
 * fetchImpl 为测试注入点。
 */
export async function downloadMediaBytes({
  encryptQueryParam, fullUrl, aesKey,
  cdnBaseUrl = CDN_BASE_URL, forceBase = false,
  maxBytes = 0, fetchImpl = fetch, timeoutMs = API_TIMEOUT_MS,
}) {
  const url = cdnDownloadUrl({ encryptQueryParam, fullUrl, cdnBaseUrl, forceBase })
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    if (!res.ok) throw new ILinkError(`CDN 下载 HTTP ${res.status}`)
    // 密文比明文最多多 16 字节（PKCS7 填充）
    const encrypted = await readBodyCapped(res, maxBytes ? maxBytes + 16 : 0, () => controller.abort())
    const plain = aesKey ? decryptAesEcb(encrypted, parseAesKey(aesKey)) : encrypted
    if (maxBytes && plain.length > maxBytes) throw new MediaTooLargeError(plain.length, maxBytes)
    return plain
  } finally {
    clearTimeout(t)
  }
}

/** 兼容旧名：图片下载就是通用媒体下载。 */
export const downloadImageBytes = downloadMediaBytes

/* ------------------------------ 入站消息解析 ------------------------------ */

/** 消息条目类型（iLink MessageItemType）。 */
export const ITEM = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 }
const MEDIA_LABEL = { 2: '[图片]', 3: '[语音]', 4: '[文件]', 5: '[视频]' }

function mediaRef(media, aesKeyOverride?) {
  if (!media || (!media.encrypt_query_param && !media.full_url)) return null
  return {
    encrypt_query_param: media.encrypt_query_param ?? '',
    full_url: media.full_url ?? '',
    aesKey: aesKeyOverride ?? media.aes_key ?? '',
  }
}

function toNumber(v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** 单个条目的媒体描述（图片/文件/视频/语音）；没有可下载媒体返回 null。 */
function describeMedia(item) {
  switch (item?.type) {
    case ITEM.IMAGE: {
      const it = item.image_item ?? {}
      // aeskey 可能是 hex（image_item.aeskey，优先）或 base64（media.aes_key）
      const ref = mediaRef(it.media, it.aeskey ? Buffer.from(it.aeskey, 'hex').toString('base64') : undefined)
      return ref ? { kind: 'image', ...ref } : null
    }
    case ITEM.FILE: {
      const it = item.file_item ?? {}
      const ref = mediaRef(it.media)
      return ref ? { kind: 'file', ...ref, name: String(it.file_name ?? '').trim() || 'weixin-file', size: toNumber(it.len) } : null
    }
    case ITEM.VIDEO: {
      const it = item.video_item ?? {}
      const ref = mediaRef(it.media)
      if (!ref) return null
      const thumb = mediaRef(it.thumb_media, it.thumb_media?.aes_key || it.media?.aes_key || '')
      return { kind: 'video', ...ref, size: toNumber(it.video_size), playLength: toNumber(it.play_length), thumb }
    }
    case ITEM.VOICE: {
      const it = item.voice_item ?? {}
      const ref = mediaRef(it.media)
      return { kind: 'voice', ...(ref ?? {}), text: it.text != null ? String(it.text) : '', playtime: toNumber(it.playtime) }
    }
    default:
      return null
  }
}

/** 引用（回复某条消息）：标题 + 被引用内容摘要；被引用的是媒体时附上下载信息。 */
function describeQuote(items) {
  const holder = items.find((it) => it?.ref_msg)
  const ref = holder?.ref_msg
  if (!ref) return null
  const mi = ref.message_item
  let body = ''
  if (mi?.type === ITEM.TEXT && mi.text_item?.text != null) body = String(mi.text_item.text)
  else if (mi?.type === ITEM.VOICE && mi.voice_item?.text) body = String(mi.voice_item.text)
  else if (mi && MEDIA_LABEL[mi.type]) body = MEDIA_LABEL[mi.type]
  const title = String(ref.title ?? '').trim()
  const parts = [title, body.trim()].filter(Boolean)
  // 标题与正文相同（常见于纯文本引用）时只保留一份
  const text = parts.length === 2 && parts[0] === parts[1] ? parts[0] : parts.join(' | ')
  const media = mi && mi.type !== ITEM.VOICE ? describeMedia(mi) : null
  if (!text && !media) return null
  return { text, media }
}

/** getupdates 响应 → 轻量入站消息列表。 */
export function normalizeInboundMessages(resp) {
  const out: any[] = []
  for (const raw of resp?.msgs ?? []) {
    const from = raw?.from_user_id
    const to = raw?.to_user_id
    const contextToken = raw?.context_token
    const items = Array.isArray(raw?.item_list) ? raw.item_list : []
    const texts = items
      .filter((it) => it?.type === ITEM.TEXT && it?.text_item?.text != null)
      .map((it) => String(it.text_item.text))
    // 语音：voice_item.text 是腾讯服务端转写结果，直接用（无需本地 ASR）
    const voiceTexts = items
      .filter((it) => it?.type === ITEM.VOICE && it?.voice_item?.text)
      .map((it) => String(it.voice_item.text))
    const nonTextTypes = items.filter((it) => it?.type !== ITEM.TEXT).map((it) => it?.type)
    const media = items.map(describeMedia).filter(Boolean)
    const images = media.filter((m) => m.kind === 'image')
    const files = media.filter((m) => m.kind === 'file')
    const videos = media.filter((m) => m.kind === 'video')
    const voices = media.filter((m) => m.kind === 'voice')
    const quote = describeQuote(items)

    if (from && (texts.length > 0 || voiceTexts.length > 0 || nonTextTypes.length > 0 || quote)) {
      out.push({
        from, to, contextToken,
        text: texts.join('\n'),
        voiceText: voiceTexts.join('\n'),
        hasText: texts.length > 0 || voiceTexts.length > 0,
        image: images[0] ?? null, // 兼容旧字段：首张图片
        images, files, videos, voices,
        quote,
        nonTextTypes,
      })
    }
  }
  return out
}

/* ------------------------------ 媒体上传（发图片/文件/视频） ------------------------------ */

/** getuploadurl 的 media_type（UploadMediaType）。 */
export const UPLOAD_MEDIA_TYPE = { IMAGE: 1, VIDEO: 2, FILE: 3 }

/** AES-128-ECB 加密（PKCS7）。 */
export function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/** PKCS7 填充后的密文长度。 */
export function aesEcbPaddedSize(plainSize) {
  return Math.ceil((plainSize + 1) / 16) * 16
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const VIDEO_EXTS = new Set(['.mp4', '.mov'])

/** 按扩展名决定发成图片 / 视频 / 文件。 */
export function outboundKind(fileName) {
  const ext = path.extname(String(fileName ?? '')).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  return 'file'
}

/** 申请上传参数。 */
export async function getUploadUrl({ baseUrl, token, filekey, mediaType, toUserId, rawsize, rawfilemd5, filesize, aeskeyHex, botAgent, post = apiPost }: any) {
  const resp = await post({
    baseUrl, endpoint: 'ilink/bot/getuploadurl', token, timeoutMs: API_TIMEOUT_MS,
    body: {
      filekey, media_type: mediaType, to_user_id: toUserId,
      rawsize, rawfilemd5, filesize, no_need_thumb: true, aeskey: aeskeyHex,
      base_info: buildBaseInfo(botAgent),
    },
  })
  return assertILinkOk('getuploadurl', resp)
}

/** 拼接 CDN 上传地址。forceBase=true（配置了 cdnBaseUrl）时忽略 upload_full_url，保证彩排/测试不碰真实 CDN。 */
export function cdnUploadUrl({ uploadParam, uploadFullUrl, filekey, cdnBaseUrl = CDN_BASE_URL, forceBase = false }) {
  const full = String(uploadFullUrl ?? '').trim()
  if (full && !forceBase) return full
  if (!uploadParam) throw new ILinkError('getuploadurl 没有返回上传参数')
  const base = String(cdnBaseUrl || CDN_BASE_URL).replace(/\/+$/, '')
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
}

/**
 * 把密文 POST 到 CDN，返回下载参数（响应头 x-encrypted-param）。
 * 5xx/网络错误最多重试 3 次；4xx 直接失败。
 */
export async function uploadToCdn({ url, ciphertext, fetchImpl = fetch, maxAttempts = 3, timeoutMs = MEDIA_TIMEOUT_MS, retryDelayMs = 500 }: any) {
  let lastErr = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        signal: controller.signal,
      })
      if (res.status >= 400 && res.status < 500) {
        const msg = res.headers?.get?.('x-error-message') ?? ''
        throw Object.assign(new ILinkError(`CDN 上传被拒 HTTP ${res.status}${msg ? `: ${msg}` : ''}`), { clientError: true })
      }
      if (res.status !== 200) throw new ILinkError(`CDN 上传失败 HTTP ${res.status}`)
      const param = res.headers?.get?.('x-encrypted-param')
      if (!param) throw new ILinkError('CDN 上传响应缺少 x-encrypted-param')
      return param
    } catch (err) {
      lastErr = err
      if (err?.clientError) throw err
      if (attempt < maxAttempts) await sleep(retryDelayMs * attempt)
    } finally {
      clearTimeout(t)
    }
  }
  throw lastErr ?? new ILinkError('CDN 上传失败')
}

/**
 * 上传一个媒体：md5 → 随机 AES 密钥 → getuploadurl → 加密 POST 到 CDN。
 * 返回 { downloadParam, aeskeyHex, plainSize, cipherSize }。
 */
export async function uploadMedia({
  baseUrl, token, to, data, mediaType, botAgent,
  cdnBaseUrl = CDN_BASE_URL, forceBase = false,
  fetchImpl = fetch, post = apiPost, retryDelayMs = 500,
}: any) {
  const plain = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const aeskey = randomBytes(16)
  const filekey = randomBytes(16).toString('hex')
  const rawfilemd5 = createHash('md5').update(plain).digest('hex')
  const cipherSize = aesEcbPaddedSize(plain.length)
  const resp = await getUploadUrl({
    baseUrl, token, filekey, mediaType, toUserId: to,
    rawsize: plain.length, rawfilemd5, filesize: cipherSize, aeskeyHex: aeskey.toString('hex'), botAgent, post,
  })
  const url = cdnUploadUrl({ uploadParam: resp.upload_param, uploadFullUrl: resp.upload_full_url, filekey, cdnBaseUrl, forceBase })
  const ciphertext = encryptAesEcb(plain, aeskey)
  const downloadParam = await uploadToCdn({ url, ciphertext, fetchImpl, retryDelayMs })
  return { downloadParam, aeskeyHex: aeskey.toString('hex'), plainSize: plain.length, cipherSize: ciphertext.length }
}

/** 上传结果 → 发送用的消息条目（字段与官方插件一致；aes_key = base64(hex 字符串)）。 */
export function buildMediaItem(kind, uploaded, fileName) {
  const media = {
    encrypt_query_param: uploaded.downloadParam,
    aes_key: Buffer.from(uploaded.aeskeyHex, 'ascii').toString('base64'),
    encrypt_type: 1,
  }
  if (kind === 'image') return { type: ITEM.IMAGE, image_item: { media, mid_size: uploaded.cipherSize } }
  if (kind === 'video') return { type: ITEM.VIDEO, video_item: { media, video_size: uploaded.cipherSize } }
  return { type: ITEM.FILE, file_item: { media, file_name: String(fileName ?? 'file'), len: String(uploaded.plainSize) } }
}
