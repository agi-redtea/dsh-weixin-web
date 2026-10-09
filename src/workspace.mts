/**
 * DSH 侧的会话呈现：固定的「微信」工作区分组 + 会话标题。
 *
 * - 工作区（ctx.workspaceRegistry）在 DSH 0.2 里就是「一个目录 + 一组会话」：所有微信会话共用同一个 cwd，
 *   用这个目录建一个标题为「微信」的工作区，把会话 attach 进去，并保持它排在侧边栏第一位。
 * - 标题（ctx.sessionTitle.rename）会「钉住」标题，之后不再自动生成；必须在第一条消息之前设置，
 *   否则模型生成的标题会先落进去。
 *
 * 两个服务都不在插件 inject 里（插件清单保持不变，老宿主也能加载）：用 ctx.get 读取，启动早期取不到时短暂等待。
 */

import fs from 'node:fs'

export const WORKSPACE_TITLE = '微信'

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 读取宿主服务；timeoutMs > 0 时等待其就绪（插件可能先于异步初始化的服务激活），超时返回 undefined。
 * 默认不等待：消息处理热路径上不能因为宿主缺服务而卡住，只有启动对账（reconcile）才显式等待。
 */
export async function waitForService(ctx, name, { timeoutMs = 0, intervalMs = 500, sleep = defaultSleep } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let service
    try { service = ctx.get?.(name) } catch { service = undefined }
    if (service) return service
    if (Date.now() >= deadline) return undefined
    await sleep(intervalMs)
  }
}

/** id 的本地部分（@ 之前）末 4 位，用于默认名/标题后缀。 */
export function idTail(id, n = 4) {
  const local = String(id ?? '').split('@')[0]
  return local.slice(-n)
}

/** 默认机器人名：iLink 不下发机器人名称/头像，只能用 ilink_bot_id 末 4 位兜底。 */
export function defaultBotName(botId) {
  const tail = idTail(botId)
  return tail ? `微信机器人 ${tail}` : '微信机器人'
}

/** 会话标题：微信·{机器人名}；同一机器人有多个对话方时追加对方 id 末 4 位。 */
export function weixinSessionTitle(botName, peerId, multiplePeers = false) {
  const base = `微信·${botName || '微信机器人'}`
  const tail = idTail(peerId)
  return multiplePeers && tail ? `${base}·${tail}` : base
}

/** 「微信」工作区：确保存在、排第一，并把会话挂进去。所有失败只记日志，不影响收发消息。 */
export class WeixinWorkspace {
  [key: string]: any
  constructor(ctx, cwd, log: (line: string) => void = () => {}, options: any = {}) {
    this.ctx = ctx
    this.cwd = cwd
    this.log = log
    this.options = options // { timeoutMs, intervalMs, sleep } 透传给 waitForService（测试用）
    this.warned = new Set()
  }

  warnOnce(key, line) {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.log(line)
  }

  /** 返回「微信」工作区实体（不存在则创建，并移到第一位）；宿主没有工作区服务时返回 null。 */
  async ensure(wait = this.options) {
    const registry = await waitForService(this.ctx, 'workspaceRegistry', wait)
    if (!registry) {
      this.warnOnce('no-registry', 'DSH 没有工作区服务（workspaceRegistry），微信会话不分组')
      return null
    }
    try {
      fs.mkdirSync(this.cwd, { recursive: true }) // create/attach 都要求目录真实存在
      const before = registry.list().map((w) => w.id)
      const workspace = await registry.create(this.cwd, WORKSPACE_TITLE)
      if (!before.includes(workspace.id)) this.log(`已创建「${WORKSPACE_TITLE}」工作区（${this.cwd}）`)
      const order = registry.list()
      if (order.length > 1 && order[0].id !== workspace.id) await registry.insertBefore(workspace.id, order[0].id)
      return workspace
    } catch (err) {
      this.warnOnce(`ensure:${err?.message}`, `准备「${WORKSPACE_TITLE}」工作区失败：${err?.message ?? err}`)
      return null
    }
  }

  /** 把会话挂进「微信」工作区（幂等）。已归档的会话不动；cwd 不一致的老会话会被宿主拒绝，只提示一次。 */
  async attach(sessionId, wait = this.options) {
    const workspace = await this.ensure(wait)
    if (!workspace || !sessionId) return false
    try {
      const registry = this.ctx.get?.('workspaceRegistry')
      if (registry?.archivedSessionIds?.includes?.(sessionId)) return false
      if (workspace.sessionIds?.includes?.(sessionId)) return true
      await workspace.attachSession(sessionId)
      this.log(`会话 ${sessionId} 已归入「${WORKSPACE_TITLE}」工作区`)
      return true
    } catch (err) {
      this.warnOnce(`attach:${sessionId}`, `会话 ${sessionId} 归入「${WORKSPACE_TITLE}」工作区失败：${err?.message ?? err}`)
      return false
    }
  }
}

/** 设置（钉住）会话标题；标题已一致时不重复写事件。返回是否改动。 */
export async function applySessionTitle(ctx, session, title, log: (line: string) => void = () => {}, options: any = {}) {
  if (!session || !title) return false
  const titles = await waitForService(ctx, 'sessionTitle', options)
  if (!titles) return false
  try {
    if (titles.get?.(session)?.title === title) return false
    titles.rename(session, title)
    log(`会话 ${session.id ?? ''} 标题设为「${title}」`)
    return true
  } catch (err) {
    log(`设置会话标题失败：${err?.message ?? err}`)
    return false
  }
}
