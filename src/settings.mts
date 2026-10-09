/**
 * 每个微信机器人的个性化设置：人设（附加系统提示）、模型、预设。存在 bots.json 的 bot.settings 里。
 *
 * - 人设：作为本机器人所有微信会话的附加系统提示段（不替换 DSH 基础提示），下一轮起生效。
 * - 模型：本机器人的微信会话每次请求都改用这个模型（覆盖会话里在网页端选的模型）；留空 = 跟随 DSH 默认。
 * - 预设：DSH 在会话创建时固定预设，所以只对之后新建的对话生效；已有对话可在抽屉里「开始新对话」。
 */

/** 人设最长字符数。 */
export const MAX_PERSONA = 4000

/** 规范化设置对象（缺省/脏数据 → 默认值）。 */
export function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const persona = typeof s.persona === 'string' ? s.persona.replace(/\r\n?/g, '\n').trim().slice(0, MAX_PERSONA) : ''
  const m = s.model && typeof s.model === 'object' ? s.model : null
  const model = m && typeof m.provider === 'string' && m.provider.trim() && typeof m.model === 'string' && m.model.trim()
    ? { provider: m.provider.trim(), model: m.model.trim() }
    : null
  const preset = typeof s.preset === 'string' && s.preset.trim() ? s.preset.trim() : null
  return { persona, model, preset }
}

/**
 * 校验并合并抽屉提交的设置补丁。字段省略 = 不改；persona '' / model null / preset null = 恢复默认。
 * 不合法时抛出带中文说明的错误。
 * @returns 合并后的规范化设置
 */
export function mergeSettings(current, patch) {
  const base = normalizeSettings(current)
  const p = patch && typeof patch === 'object' ? patch : {}
  const next = { ...base }
  if (p.persona !== undefined) {
    if (p.persona !== null && typeof p.persona !== 'string') throw new Error('人设必须是文本')
    const text = String(p.persona ?? '').replace(/\r\n?/g, '\n').trim()
    if (text.length > MAX_PERSONA) throw new Error(`人设最多 ${MAX_PERSONA} 个字（当前 ${text.length}）`)
    next.persona = text
  }
  if (p.model !== undefined) {
    if (p.model === null || p.model === '') next.model = null
    else {
      const m = p.model
      if (typeof m !== 'object' || typeof m.provider !== 'string' || !m.provider.trim() || typeof m.model !== 'string' || !m.model.trim()) {
        throw new Error('模型需要同时指定 provider 和 model')
      }
      next.model = { provider: m.provider.trim(), model: m.model.trim() }
    }
  }
  if (p.preset !== undefined) {
    if (p.preset === null || p.preset === '') next.preset = null
    else if (typeof p.preset !== 'string') throw new Error('预设必须是预设 id')
    else next.preset = p.preset.trim() || null
  }
  return next
}

/** 设置是否全为默认（用于存储时省略空对象）。 */
export function isDefaultSettings(s) {
  const n = normalizeSettings(s)
  return !n.persona && !n.model && !n.preset
}

/** 人设系统提示段正文；无人设时为空串（DSH 会跳过空段）。 */
export function personaPromptText(persona) {
  const text = String(persona ?? '').trim()
  if (!text) return ''
  return '以下是用户为这个微信机器人设定的人设与说话风格。在微信对话中请遵循它'
    + '（它不改变你的安全规则和工具使用规则）：\n' + text
}

/**
 * 「本机器人模型覆盖会话模型」的请求改写：已设模型且与当前请求不同时替换 provider/model，
 * 并去掉沿用自原模型的 reasoningEffort / maxTokens（交给新模型的适配器默认值）。
 */
export function overrideRequestModel(resolved, model) {
  if (!model || !resolved || typeof resolved !== 'object') return resolved
  if (resolved.provider === model.provider && resolved.model === model.model) return resolved
  const { reasoningEffort: _effort, maxTokens: _max, ...rest } = resolved
  return { ...rest, provider: model.provider, model: model.model }
}
