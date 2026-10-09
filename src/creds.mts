// @ts-nocheck
/**
 * 插件状态存储：凭证（bot_token/baseurl）、微信用户→会话映射、getupdates 游标。
 * 状态目录由 Config.stateDir 决定；默认落在 $DSH_HOME/dsh-weixin-web/（无则 ~/.dsh/dsh-weixin-web/）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 解析状态目录：优先 Config.stateDir，其次 $DSH_HOME，最后 ~/.dsh。 */
export function resolveStateDir(configStateDir) {
  if (configStateDir && String(configStateDir).trim()) return path.resolve(String(configStateDir).trim())
  const home = process.env.DSH_HOME?.trim()
  const base = home || path.join(os.homedir(), '.dsh')
  return path.join(base, 'dsh-weixin-web')
}

/** 解析 agent 工作目录（会话命名空间 + 文件工具根）。Config.cwd 为空时取 stateDir/workspace，保证跨重启稳定。 */
export function resolveWorkspaceDir(configCwd, stateDir) {
  if (configCwd && String(configCwd).trim()) return path.resolve(String(configCwd).trim())
  return path.join(path.resolve(stateDir), 'workspace')
}

function loadJson(file, def) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return def
  }
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // 原子写 + 0600 权限：先写临时文件再 rename，避免中途崩溃留下半截文件；
  // 0o600 防止 bot_token 等凭据对同机其它用户可读（review I4、S9）
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** 机器人 id → 文件名安全的片段（游标文件 bufs/<id>.json）。 */
export function safeBotFile(id) {
  return String(id ?? '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || '_'
}

/**
 * 以 stateDir 为根创建状态存储。
 * v1（单机器人）：credentials.json / session-map.json / updates-buf.json。
 * v2（多机器人）：bots.json（机器人列表含凭据，0600）/ session-map.v2.json（{ botId: { 微信用户: 会话 } }）/ bufs/<botId>.json。
 * v1 文件在迁移后保留不删（回滚旧版时仍可用）。
 */
export function createStore(stateDir) {
  const dir = path.resolve(stateDir)
  const credFile = path.join(dir, 'credentials.json')
  const sessionMapFile = path.join(dir, 'session-map.json')
  const bufFile = path.join(dir, 'updates-buf.json')
  const botsFile = path.join(dir, 'bots.json')
  const mapsFile = path.join(dir, 'session-map.v2.json')
  const botBufFile = (id) => path.join(dir, 'bufs', `${safeBotFile(id)}.json`)

  return {
    dir,
    loadCredentials: () => loadJson(credFile, null),
    saveCredentials: (cred) => saveJson(credFile, cred),
    loadSessionMap: () => loadJson(sessionMapFile, {}),
    saveSessionMap: (map) => saveJson(sessionMapFile, map),
    loadBuf: () => {
      const d = loadJson(bufFile, null)
      return typeof d?.buf === 'string' ? d.buf : ''
    },
    saveBuf: (buf) => saveJson(bufFile, { buf, savedAt: Date.now() }),
    // ---- v2 多机器人 ----
    hasBots: () => fs.existsSync(botsFile),
    loadBots: () => {
      const d = loadJson(botsFile, null)
      return Array.isArray(d?.bots) ? d.bots.filter((b) => b && typeof b.id === 'string') : []
    },
    saveBots: (bots) => saveJson(botsFile, { version: 2, bots }),
    loadSessionMaps: () => {
      const d = loadJson(mapsFile, {})
      return d && typeof d === 'object' && !Array.isArray(d) ? d : {}
    },
    saveSessionMaps: (maps) => saveJson(mapsFile, maps),
    loadBotBuf: (id) => {
      const d = loadJson(botBufFile(id), null)
      return typeof d?.buf === 'string' ? d.buf : ''
    },
    saveBotBuf: (id, buf) => saveJson(botBufFile(id), { buf, savedAt: Date.now() }),
    removeBotBuf: (id) => { try { fs.rmSync(botBufFile(id), { force: true }) } catch { /* ignore */ } },
  }
}