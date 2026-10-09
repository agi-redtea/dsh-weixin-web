// @ts-nocheck
/** DSH 原生抽屉使用的 iLink 扫码登录流程；不暴露 HTTP 路由。 */

import qrcode from 'qrcode-generator'
import * as ilink from './ilink.mjs'

const LOGIN_TIMEOUT_MS = 5 * 60_000
const MAX_QR_REFRESH = 3
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** qrcode-generator 矩阵 → SVG 字符串。 */
export function qrSvg(text, size = 320) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const cell = size / (n + 2 * 4)
  let cells = ''
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        cells += `<rect x="${(c + 4) * cell}" y="${(r + 4) * cell}" width="${cell + 0.4}" height="${cell + 0.4}"/>`
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${cells}</svg>`
}

/* ------------------------------ 登录流程 ------------------------------ */

/** 本机已有的 bot_token（多机器人时全部带上，iLink 最多接受 10 个）。 */
function localTokens(channel) {
  if (typeof channel.localTokenList === 'function') return channel.localTokenList()
  return channel.creds?.bot_token ? [channel.creds.bot_token] : []
}

/** 是否已有任何可用凭据（决定 binded_redirect 视为「沿用现有凭据」还是失败）。 */
function hasAnyBot(channel) {
  if (typeof channel.hasAnyBot === 'function') return channel.hasAnyBot()
  return !!channel.creds?.bot_token
}

function loginBaseUrl(channel) {
  return channel.loginBaseUrl || ilink.DEFAULT_BASE_URL
}

function fetchQR(channel) {
  return ilink.fetchQRCode({ baseUrl: loginBaseUrl(channel), localTokenList: localTokens(channel) })
}

export async function startLogin(channel) {
  if (channel.login?.poller) {
    return { started: true, message: '登录流程已在运行' }
  }
  const qr = await fetchQR(channel)
  if (!qr?.qrcode || !qr?.qrcode_img_content) {
    throw new Error(`get_bot_qrcode 响应缺少字段：${JSON.stringify(qr).slice(0, 200)}`)
  }
  const login = {
    status: 'wait',
    qrCode: qr.qrcode,
    qrUrl: qr.qrcode_img_content,
    apiBaseUrl: loginBaseUrl(channel),
    pendingVerifyCode: undefined,
    qrRefreshCount: 0,
    startedAt: Date.now(),
    message: '请用手机微信扫描二维码',
    poller: null,
  }
  channel.login = login
  channel.pushLog('DSH 原生抽屉发起扫码登录')
  login.poller = pollLogin(channel, login)
  return { started: true, message: '登录流程已启动' }
}

async function pollLogin(channel, login) {
  try {
    let failures = 0
    while (Date.now() - login.startedAt < LOGIN_TIMEOUT_MS) {
      let status
      try {
        status = await ilink.pollQRStatus({ baseUrl: login.apiBaseUrl, qrcode: login.qrCode, verifyCode: login.pendingVerifyCode })
        failures = 0
      } catch (err) {
        // 瞬时网络错误容忍：连续 3 次才终止登录，避免一次抖动废掉整个流程（review 二轮 N2）
        failures += 1
        if (failures >= 3) throw err
        channel.pushLog(`登录轮询瞬时错误（${failures}/3）：${err?.message ?? err}，稍后重试`)
        await sleep(1000 * failures)
        continue
      }
      switch (status.status) {
        case 'wait':
          break
        case 'scaned':
          if (login.pendingVerifyCode) login.pendingVerifyCode = undefined
          login.status = 'scaned'
          login.message = '已扫码，正在验证…'
          break
        case 'need_verifycode':
          login.status = 'need_verifycode'
          login.message = login.pendingVerifyCode
            ? '验证码不匹配，请在手机微信查看并重新输入'
            : '手机微信上显示了数字验证码，请在面板输入'
          return // 等待面板提交验证码（submitVerifyCode 会继续轮询）
        case 'expired': {
          login.qrRefreshCount += 1
          if (login.qrRefreshCount > MAX_QR_REFRESH) {
            login.status = 'expired'
            login.message = '二维码多次过期，请重新发起登录'
            return
          }
          const qr = await fetchQR(channel)
          login.qrCode = qr?.qrcode ?? login.qrCode
          login.qrUrl = qr?.qrcode_img_content ?? login.qrUrl
          login.pendingVerifyCode = undefined
          login.message = '二维码已刷新，请重新扫描'
          break
        }
        case 'verify_code_blocked':
          login.pendingVerifyCode = undefined
          login.status = 'need_verifycode'
          login.message = '验证码错误次数过多，请重新扫描（二维码已刷新）'
          {
            const qr = await fetchQR(channel)
            login.qrCode = qr?.qrcode ?? login.qrCode
            login.qrUrl = qr?.qrcode_img_content ?? login.qrUrl
          }
          break
        case 'binded_redirect':
          // 已有 token（重连）：沿用现有凭据视为成功；首次登录（无 token）则刷新二维码重试
          if (hasAnyBot(channel)) {
            login.status = 'confirmed'
            login.message = '该微信已绑定，沿用现有凭据'
            return
          }
          login.qrRefreshCount += 1
          if (login.qrRefreshCount > MAX_QR_REFRESH) {
            login.status = 'error'
            login.message = '该微信已绑定其它机器人，无法获取新凭据，请确认后重试'
            return
          }
          login.pendingVerifyCode = undefined
          login.message = '该微信已绑定其它机器人，刷新二维码…'
          {
            const qr = await fetchQR(channel)
            login.qrCode = qr?.qrcode ?? login.qrCode
            login.qrUrl = qr?.qrcode_img_content ?? login.qrUrl
          }
          break
        case 'scaned_but_redirect':
          if (status.redirect_host) {
            login.apiBaseUrl = `https://${status.redirect_host}`
            channel.pushLog(`登录轮询切换节点：${status.redirect_host}`)
          }
          break
        case 'confirmed': {
          const token = status.bot_token ?? status.token
          const baseurl = status.baseurl ?? login.apiBaseUrl
          if (!token) {
            login.status = 'error'
            login.message = '服务器未返回 bot_token'
            return
          }
          let applied
          try {
            applied = channel.applyCredentials({ bot_token: token, baseurl, ilink_bot_id: status.ilink_bot_id, ilink_user_id: status.ilink_user_id, loggedInAt: Date.now() })
          } catch (err) {
            login.status = 'error'
            login.message = err?.message ?? String(err)
            channel.pushLog(`扫码成功但未能保存机器人：${login.message}`)
            return
          }
          login.status = 'confirmed'
          login.message = applied?.isNew === false ? '已重新登录该机器人' : '登录成功！'
          if (applied?.botId) { login.botId = applied.botId; login.isNew = applied.isNew !== false }
          channel.pushLog('扫码登录成功')
          return
        }
        default:
          break
      }
      await sleep(1000)
    }
    login.status = 'expired'
    login.message = '登录超时，请重新发起'
  } catch (err) {
    login.status = 'error'
    login.message = `登录失败：${err?.message ?? err}`
    channel.pushLog(`登录失败：${err?.message ?? err}`)
  } finally {
    login.poller = null
    // 终态记录完成时间：面板停止展示二维码，宽限后自动收起卡片（review S3）
    if (login.status === 'confirmed' || login.status === 'error' || login.status === 'expired') {
      login.finishedAt = Date.now()
    }
  }
}

/** 面板提交验证码后：存下并恢复轮询。 */
export function submitVerifyCode(channel, code) {
  const login = channel.login
  if (!login) return { ok: false, message: '没有进行中的登录' }
  if (login.status !== 'need_verifycode') return { ok: false, message: `当前状态 ${login.status}，无需验证码` }
  login.pendingVerifyCode = String(code).trim()
  login.status = 'wait'
  login.message = '已提交验证码，继续验证…'
  if (!login.poller) login.poller = pollLogin(channel, login)
  return { ok: true, message: '验证码已提交' }
}

/* ------------------------------ 路由注册 ------------------------------ */

