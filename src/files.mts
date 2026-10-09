/**
 * send_weixin_file 的路径检查：只允许发送会话工作目录、微信工作区或 DSH 附件目录里的普通文件（按真实路径判断，
 * 防止 ../ 或符号链接跳出），且不超过大小上限。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** DSH 附件根目录（$DSH_HOME/attachments，无 DSH_HOME 时 ~/.dsh/attachments）。 */
export function defaultAttachmentsRoot() {
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, 'attachments')
}

function within(child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

async function realOrNull(p) {
  try { return await fs.realpath(p) } catch { return null }
}

/**
 * @param {string} p 模型给的路径（相对路径按会话工作目录解析）
 * @param {{ cwd?: string, roots: string[], maxBytes: number }} opts
 * @returns {Promise<{ path: string, name: string, size: number }>}
 */
export async function resolveSendableFile(p, { cwd, roots, maxBytes }) {
  const raw = String(p ?? '').trim()
  if (!raw) throw new Error('缺少 path（要发送的文件路径）')
  const base = cwd || roots.find(Boolean) || process.cwd()
  const abs = path.resolve(base, raw)
  const real = await realOrNull(abs)
  if (!real) throw new Error(`文件不存在：${raw}`)
  const allowed: string[] = []
  for (const r of roots.filter(Boolean)) {
    const rr = await realOrNull(r)
    if (rr) allowed.push(rr)
  }
  if (!allowed.some((r) => within(real, r))) {
    throw new Error('只能发送当前会话工作目录、微信工作区或 DSH 附件里的文件')
  }
  const st = await fs.stat(real)
  if (!st.isFile()) throw new Error(`不是普通文件：${raw}`)
  if (st.size === 0) throw new Error(`文件是空的：${raw}`)
  if (maxBytes && st.size > maxBytes) throw new Error(`文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB，微信发不了：${raw}`)
  return { path: real, name: path.basename(abs), size: st.size }
}
