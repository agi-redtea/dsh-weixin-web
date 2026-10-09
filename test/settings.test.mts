// @ts-nocheck
/**
 * 每个机器人的人设 / 模型 / 预设设置、「开始新对话」、旧会话映射清理，以及对应的抽屉 RPC。
 * 全部用本地假宿主，不访问 iLink。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WeixinChannel } from '../src/index.mjs'
import { WeixinHub, UNBOUND_KEY } from '../src/hub.mjs'
import { createStore } from '../src/creds.mjs'
import { createWeixinRpcHandler } from '../src/rpc.mjs'
import { MAX_PERSONA, mergeSettings, normalizeSettings, overrideRequestModel, personaPromptText } from '../src/settings.mjs'

WeixinChannel.prototype.startMonitor = async function () { this.monitorRunning = true }

const DEAD = 'http://127.0.0.1:9'
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wx-settings-'))
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))

/** 假宿主服务：两个模型（一个能看图）、两个预设（一个损坏）、默认模型。 */
function fakeServices(extra = {}) {
  const mounted = []
  return {
    mounted,
    llm: {
      listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
      listModels: async () => [
        { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'V4 Flash', inputModalities: ['text'] },
        { provider: 'deepseek-official', id: 'deepseek-v4-vl', name: 'V4 VL', inputModalities: ['text', 'image'] },
      ],
      resolveModelInfo: async (provider, model) => {
        if (provider !== 'deepseek-official' || !['deepseek-v4-flash', 'deepseek-v4-vl'].includes(model)) throw new Error('unknown model')
        return { inputModalities: model.endsWith('-vl') ? ['text', 'image'] : ['text'] }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }) },
    agentPresets: {
      list: async () => [{ id: 'default', name: '默认' }, { id: 'coder', name: '写代码' }, { id: 'bad', name: '坏的', broken: 'x' }],
      resolve: async (id) => {
        const want = id ?? 'default'
        if (!['default', 'coder', 'bad'].includes(want)) throw Object.assign(new Error(`Unknown agent preset: ${want}`), { code: 'agent-preset/not-found' })
        return want === 'bad' ? { id: want, broken: 'plugin failed' } : { id: want }
      },
      mount: async (_ctx, id) => { mounted.push(id); return { id } },
    },
    ...extra,
  }
}

function makeCtx(services) {
  return { on: () => () => {}, get: (n) => services[n], logger: { info() {}, warn() {} }, agents: services.agents }
}

function makeHub(dir, services = fakeServices()) {
  const ctx = makeCtx(services)
  const cfg = { cwd: path.join(dir, 'workspace'), replyMode: 'full', replyTimeoutMs: 60_000, maxChunk: 1500, sendIntervalMs: 0 }
  const store = createStore(dir)
  const hub = new WeixinHub(ctx, cfg, store, {
    createChannel: (s, o) => { const ch = new WeixinChannel(ctx, cfg, s, o); ch.logSink = () => {}; return ch },
  })
  hub.logSink = () => {}
  return { hub, ctx, store, services }
}

const cred = (n) => ({ bot_token: `tok-${n}`, baseurl: DEAD, ilink_bot_id: `bot${n}@im.bot`, ilink_user_id: `scanner${n}@im.wechat`, loggedInAt: Date.now() })

/* ------------------------------ 纯函数 ------------------------------ */

test('normalizeSettings / mergeSettings：默认值、校验与恢复默认', () => {
  assert.deepEqual(normalizeSettings(undefined), { persona: '', model: null, preset: null })
  assert.deepEqual(normalizeSettings({ persona: '  hi \r\n ', model: { provider: 'p' }, preset: ' ' }), { persona: 'hi', model: null, preset: null })
  const a = mergeSettings(undefined, { persona: '你是小可爱', model: { provider: 'p', model: 'm' }, preset: 'coder' })
  assert.deepEqual(a, { persona: '你是小可爱', model: { provider: 'p', model: 'm' }, preset: 'coder' })
  // 省略的字段不变；null / 空串 = 恢复默认
  assert.deepEqual(mergeSettings(a, { model: null }), { ...a, model: null })
  assert.deepEqual(mergeSettings(a, { preset: '' }), { ...a, preset: null })
  assert.deepEqual(mergeSettings(a, { persona: '' }), { ...a, persona: '' })
  assert.deepEqual(mergeSettings(a, {}), a)
  assert.throws(() => mergeSettings(a, { persona: 'x'.repeat(MAX_PERSONA + 1) }), /最多 4000/)
  assert.throws(() => mergeSettings(a, { model: { provider: 'p' } }), /provider 和 model/)
  assert.throws(() => mergeSettings(a, { persona: 3 }), /人设必须是文本/)
})

test('overrideRequestModel：换模型时替换 provider/model 并去掉沿用的 reasoningEffort/maxTokens；同模型/未设置原样返回', () => {
  const req = { provider: 'a', model: 'x', reasoningEffort: 'high', maxTokens: 8000, temperature: 1 }
  assert.deepEqual(overrideRequestModel(req, { provider: 'b', model: 'y' }), { provider: 'b', model: 'y', temperature: 1 })
  assert.equal(overrideRequestModel(req, { provider: 'a', model: 'x' }), req)
  assert.equal(overrideRequestModel(req, null), req)
  assert.equal(personaPromptText(''), '')
  assert.match(personaPromptText('说话活泼'), /人设[\s\S]*说话活泼/)
})

/* ------------------------------ 通道：setup / 模型 / 预设 ------------------------------ */

function fakeAgentCtx() {
  const sections = []
  const hooks = []
  return {
    sections, hooks,
    systemPrompt: { section: (s) => sections.push(s) },
    on: (name, fn, opts) => { hooks.push({ name, fn, opts }); return () => {} },
  }
}

test('composeSetup：人设段每次组装读取最新设置；模型覆盖挂在请求瀑布最外层；按指定预设装配', async () => {
  const services = fakeServices()
  const dir = tmpDir()
  const { hub } = makeHub(dir, services)
  const { botId } = hub.applyCredentials(cred(1))
  const ch = hub.channel(botId)
  const actx = fakeAgentCtx()
  await (await ch.composeSetup('coder'))(actx)
  assert.deepEqual(services.mounted, ['coder'])
  const persona = actx.sections.find((s) => s.name === 'weixin:persona')
  assert.equal(persona.interpolate, false, '人设是自由文本，不做模板替换')
  assert.equal(persona.text(), '')
  const request = actx.hooks.find((h) => h.name === 'agent/request')
  const assemble = actx.hooks.find((h) => h.name === 'system-prompt/assemble')
  assert.equal(request.opts.prepend, true)
  assert.equal(assemble.opts.prepend, true)
  const base = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }
  assert.deepEqual(await request.fn({}, async () => base), base, '未设模型：不改写')

  // 抽屉里改设置：同一个已装配的会话下一次请求/组装即生效
  await hub.updateBotSettings(botId, { persona: '你叫小可爱', model: { provider: 'deepseek-official', model: 'deepseek-v4-vl' } })
  assert.match(persona.text(), /你叫小可爱/)
  assert.deepEqual(await request.fn({}, async () => base), { provider: 'deepseek-official', model: 'deepseek-v4-vl' })
  const assembled = await assemble.fn({}, {}, async () => ({ sections: [], variables: { provider: 'deepseek-official', model: 'deepseek-v4-flash', cwd: '/w' } }))
  assert.deepEqual(assembled.variables, { provider: 'deepseek-official', model: 'deepseek-v4-vl', cwd: '/w' })
})

test('composeSetup：指定的预设装配失败时退回 DSH 默认预设', async () => {
  const services = fakeServices()
  const orig = services.agentPresets.mount
  services.agentPresets.mount = async (c, id) => { if (id === 'coder') throw new Error('mount failed'); return orig(c, id) }
  const { hub } = makeHub(tmpDir(), services)
  const ch = hub.channel(hub.applyCredentials(cred(1)).botId)
  await (await ch.composeSetup('coder'))(fakeAgentCtx())
  assert.deepEqual(services.mounted, ['default'])
})

test('新会话：用机器人模型作 agentOptions，预设写进 meta 并装配；未设置时与旧版一致（默认模型、默认预设）', async () => {
  const created = []
  const services = fakeServices({
    agents: {
      get: () => undefined,
      create: async (opts) => { created.push(opts); await opts.setup(fakeAgentCtx()); return { agent: { id: opts.sessionId, session: { id: opts.sessionId } } } },
    },
  })
  const { hub } = makeHub(tmpDir(), services)
  const ch = hub.channel(hub.applyCredentials(cred(1)).botId)
  await ch.ensureAgentFor('peer-1@im.wechat')
  assert.deepEqual(created[0].agentOptions, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  assert.equal(created[0].meta.agentPreset, undefined)
  assert.deepEqual(services.mounted, ['default'])

  await hub.updateBotSettings(ch.creds.id ?? [...hub.channels.keys()][0], { model: { provider: 'deepseek-official', model: 'deepseek-v4-vl' }, preset: 'coder' })
  await ch.ensureAgentFor('peer-2@im.wechat')
  assert.deepEqual(created[1].agentOptions, { provider: 'deepseek-official', model: 'deepseek-v4-vl' })
  assert.equal(created[1].meta.agentPreset, 'coder')
  assert.deepEqual(services.mounted, ['default', 'coder'])
})

test('恢复已有会话：装配会话创建时记录的预设（不是机器人当前预设），并释放会话观察句柄', async () => {
  let disposed = 0
  const resumed = []
  const services = fakeServices({
    sessionQuery: {
      observeSession: async (id) => ({ projections: { values: { agentPreset: id === 's-coder' ? 'coder' : undefined } }, [Symbol.dispose]() { disposed += 1 } }),
    },
    agents: {
      get: () => undefined,
      resume: async (opts) => { resumed.push(opts); await opts.setup(fakeAgentCtx()); return { agent: { id: opts.resumeSessionId, session: { id: opts.resumeSessionId } } } },
    },
  })
  const { hub } = makeHub(tmpDir(), services)
  const id = hub.applyCredentials(cred(1)).botId
  await hub.updateBotSettings(id, { preset: 'default' })
  const ch = hub.channel(id)
  await ch.openMappedSession('s-coder')
  await ch.openMappedSession('s-old')
  assert.deepEqual(services.mounted, ['coder', 'default'])
  assert.equal(disposed, 2)
})

test('supportsVision：机器人模型优先于会话记录与默认模型', async () => {
  const services = fakeServices()
  const { hub } = makeHub(tmpDir(), services)
  const id = hub.applyCredentials(cred(1)).botId
  const ch = hub.channel(id)
  const agent = { options: {}, session: { requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } }
  assert.equal(await ch.supportsVision(agent), false)
  await hub.updateBotSettings(id, { model: { provider: 'deepseek-official', model: 'deepseek-v4-vl' } })
  assert.equal(await ch.supportsVision(agent), true)
  // 会话记录的模型（没设机器人模型时）也会被尊重
  await hub.updateBotSettings(id, { model: null })
  const vlAgent = { options: {}, session: { requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-v4-vl' } }) } }
  assert.equal(await ch.supportsVision(vlAgent), true)
})

/* ------------------------------ hub：设置持久化 / 校验 / 选项 ------------------------------ */

test('updateBotSettings：校验模型与预设、持久化到 bots.json、重新扫码后保留；全部清空时删掉 settings', async () => {
  const dir = tmpDir()
  const { hub } = makeHub(dir)
  const id = hub.applyCredentials(cred(1)).botId
  await assert.rejects(hub.updateBotSettings(id, { model: { provider: 'deepseek-official', model: 'nope' } }), /不可用/)
  await assert.rejects(hub.updateBotSettings(id, { model: { provider: 'other', model: 'x' } }), /没有模型服务商/)
  await assert.rejects(hub.updateBotSettings(id, { preset: 'missing' }), /Unknown agent preset/)
  await assert.rejects(hub.updateBotSettings(id, { preset: 'bad' }), /不可用/)
  await assert.rejects(hub.updateBotSettings('nobody', { persona: 'x' }), /未找到机器人/)

  await hub.updateBotSettings(id, { persona: '你叫小可爱', model: { provider: 'deepseek-official', model: 'deepseek-v4-vl' }, preset: 'coder' })
  const saved = readJson(path.join(dir, 'bots.json')).bots[0]
  assert.deepEqual(saved.settings, { persona: '你叫小可爱', model: { provider: 'deepseek-official', model: 'deepseek-v4-vl' }, preset: 'coder' })
  assert.equal(saved.bot_token, 'tok-1', '凭据不受影响')
  assert.deepEqual(hub.statusView().bots[0].settings, saved.settings)

  // 重新扫码（同一机器人）：凭据更新，设置保留
  hub.applyCredentials({ ...cred(1), bot_token: 'tok-1b' })
  const again = readJson(path.join(dir, 'bots.json')).bots[0]
  assert.equal(again.bot_token, 'tok-1b')
  assert.deepEqual(again.settings, saved.settings)
  assert.equal(hub.channel(id).botSettings().persona, '你叫小可爱')

  // 重启后仍在
  const { hub: hub2 } = makeHub(dir)
  assert.equal(hub2.channel(id).botModel().model, 'deepseek-v4-vl')

  await hub.updateBotSettings(id, { persona: '', model: null, preset: null })
  assert.equal('settings' in readJson(path.join(dir, 'bots.json')).bots[0], false)
  assert.deepEqual(hub.channel(id).botSettings(), { persona: '', model: null, preset: null })
})

test('settingsOptions：列出模型（标注能否看图）、预设与 DSH 默认值', async () => {
  const { hub } = makeHub(tmpDir())
  const o = await hub.settingsOptions()
  assert.deepEqual(o.models.map((m) => [m.model, m.vision]), [['deepseek-v4-flash', false], ['deepseek-v4-vl', true]])
  assert.deepEqual(o.defaultModel, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  assert.deepEqual(o.presets.map((p) => [p.id, p.broken]), [['default', false], ['coder', false], ['bad', true]])
  assert.equal(o.defaultPreset, 'default')
  assert.equal(o.maxPersona, 4000)
  // 宿主没有这些服务：空列表，不报错
  const { hub: bare } = makeHub(tmpDir(), {})
  assert.deepEqual(await bare.settingsOptions(), { models: [], defaultModel: null, presets: [], defaultPreset: null, maxPersona: 4000 })
})

/* ------------------------------ 旧会话映射清理 ------------------------------ */

test('pruneSupersededMaps：删除被新绑定接替的旧机器人映射；独有对话方与旧版占位键保留', () => {
  const dir = tmpDir()
  const store = createStore(dir)
  store.saveBots([{ id: 'new@im.bot', name: '绿茶茶', bot_token: 't', baseurl: DEAD, ilink_bot_id: 'new@im.bot', ilink_user_id: 'peerB@im.wechat', enabled: true }])
  store.saveSessionMaps({
    'old@im.bot': { 'peerB@im.wechat': 'session-old' },
    'gone@im.bot': { 'peerC@im.wechat': 'session-c', 'peerB@im.wechat': 'session-old2' },
    'new@im.bot': { 'peerB@im.wechat': 'session-new' },
    [UNBOUND_KEY]: { 'peerB@im.wechat': 'session-x' },
  })
  const { hub } = makeHub(dir)
  const maps = readJson(path.join(dir, 'session-map.v2.json'))
  assert.deepEqual(maps, {
    'gone@im.bot': { 'peerC@im.wechat': 'session-c' },
    'new@im.bot': { 'peerB@im.wechat': 'session-new' },
    [UNBOUND_KEY]: { 'peerB@im.wechat': 'session-x' },
  })
  assert.deepEqual(hub.channel('new@im.bot').sessionMap, { 'peerB@im.wechat': 'session-new' })
  assert.equal(hub.pruneSupersededMaps(), 0, '幂等')
})

/* ------------------------------ 开始新对话 ------------------------------ */

test('开始新对话：旧会话标题加「旧对话」并保留，新建会话接管该联系人；回复进行中拒绝；新建失败恢复旧映射', async () => {
  const renamed = []
  let fail = false
  const services = fakeServices({
    sessionTitle: { get: () => undefined, rename: (session, title) => renamed.push([session.id, title]) },
    agents: {
      get: (id) => (id === 'session-old' ? { id, session: { id } } : undefined),
      create: async (opts) => { if (fail) throw new Error('disk full'); return { agent: { id: opts.sessionId, session: { id: opts.sessionId } } } },
    },
  })
  const dir = tmpDir()
  const { hub } = makeHub(dir, services)
  const id = hub.applyCredentials(cred(1)).botId
  await hub.renameBot(id, '绿茶茶')
  const ch = hub.channel(id)
  ch.sessionMap = { 'scanner1@im.wechat': 'session-old' }
  ch.store.saveSessionMap(ch.sessionMap)

  ch.pending.set('m1', { from: 'scanner1@im.wechat' })
  await assert.rejects(hub.startNewChat(id, 'scanner1@im.wechat'), /正在回复/)
  ch.pending.clear()
  await assert.rejects(hub.startNewChat(id, 'stranger@im.wechat'), /还没有和该联系人的对话/)

  const r = await hub.startNewChat(id, 'scanner1@im.wechat')
  assert.equal(r.oldSessionId, 'session-old')
  assert.match(r.sessionId, /^session-/)
  assert.notEqual(r.sessionId, 'session-old')
  assert.equal(ch.sessionMap['scanner1@im.wechat'], r.sessionId)
  assert.equal(readJson(path.join(dir, 'session-map.v2.json'))[id]['scanner1@im.wechat'], r.sessionId)
  assert.ok(renamed.some(([sid, title]) => sid === 'session-old' && /^微信·绿茶茶·旧对话 \d+\/\d+$/.test(title)), JSON.stringify(renamed))
  assert.ok(renamed.some(([sid, title]) => sid === r.sessionId && title === '微信·绿茶茶'))

  fail = true
  const current = ch.sessionMap['scanner1@im.wechat']
  await assert.rejects(hub.startNewChat(id, 'scanner1@im.wechat'), /disk full/)
  assert.equal(ch.sessionMap['scanner1@im.wechat'], current, '新建失败：联系人仍指向原会话')
})

/* ------------------------------ RPC ------------------------------ */

test('RPC：bot/options 返回选项；bot/settings 只传提交的字段；bot/new-chat 需要 peer', async () => {
  const calls = []
  const hub = {
    login: null,
    contactActivity: new Map(),
    statusView: () => ({ login: { active: false }, sessionMap: {}, bots: [] }),
    settingsOptions: async () => ({ models: [{ provider: 'p', model: 'm' }] }),
    updateBotSettings: async (id, patch) => { calls.push(['settings', id, patch]) },
    startNewChat: async (id, peer) => { calls.push(['new-chat', id, peer]); return { oldSessionId: 's1', sessionId: 's2' } },
  }
  const handle = createWeixinRpcHandler(hub)
  const o = await handle('bot/options', { botId: 'a' })
  assert.equal(o.ok, true)
  assert.deepEqual(o.value.options.models, [{ provider: 'p', model: 'm' }])
  assert.equal((await handle('bot/settings', { botId: 'a', persona: 'hi', junk: 1 })).ok, true)
  assert.equal((await handle('bot/settings', { botId: 'a', model: null, preset: 'coder' })).ok, true)
  const nc = await handle('bot/new-chat', { botId: 'a', peer: 'u@im.wechat' })
  assert.deepEqual(nc.value.newChat, { oldSessionId: 's1', sessionId: 's2' })
  assert.match((await handle('bot/new-chat', { botId: 'a' })).error.message, /缺少 peer/)
  assert.deepEqual(calls, [
    ['settings', 'a', { persona: 'hi' }],
    ['settings', 'a', { model: null, preset: 'coder' }],
    ['new-chat', 'a', 'u@im.wechat'],
  ])
  const err = createWeixinRpcHandler({ ...hub, updateBotSettings: async () => { throw new Error('人设最多 4000 个字') } })
  assert.match((await err('bot/settings', { botId: 'a', persona: 'x' })).error.message, /最多 4000/)
})
