// @ts-nocheck
/**
 * DSH 浏览器端 client.js 测试：jsdom + React 18 渲染真实 client.js，模拟 DSH 宿主的 slots / connection.rpc。
 * 覆盖：语法可解析（语法错误会让整个 DSH 页面「Failed to load plugins」）、扫码登录、二维码渲染、验证码提交、
 * 错误展示、红色异常态、退出登录、打开时轮询 / 关闭后停止、Esc 关闭、联系人预览。
 */

import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { JSDOM } from 'jsdom'

const SOURCE = fs.readFileSync(new URL('../../client.js', import.meta.url), 'utf8')

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const win = dom.window
globalThis.window = win
globalThis.document = win.document
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true, writable: true })
globalThis.HTMLElement = win.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { act } = React

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

/** 载入 client.js 并挂到假的 DSH 宿主上，返回操作句柄。 */
async function mount(respond, { services = {} } = {}) {
  const calls = []
  const opened = []
  win.open = (url) => { opened.push(url); return null }
  win.confirm = () => true
  let plugin
  win.__ModuleLoader__ = { load({ id, factory }) { assert.equal(id, 'dsh-weixin-web'); plugin = factory((name) => { if (name === 'react') return React; throw new Error(`unexpected require ${name}`) }) } }
  new Function('window', SOURCE)(win)
  assert.deepEqual(plugin.inject, ['slots', 'connection'])
  const regs = {}
  const disposers = []
  const ctx = {
    connection: { rpc: { call: async (channel, endpoint, payload) => { calls.push({ channel, endpoint, payload }); return respond(endpoint, payload, calls) } } },
    slots: { inject: (_name, fn) => fn(), register: (meta, Component) => { (regs[meta.name] ||= []).push(Component); return () => {} } },
    effect: (fn) => { disposers.push(fn()) },
    get: (name) => services[name],
  }
  plugin.apply(ctx)
  const container = win.document.createElement('div')
  win.document.body.appendChild(container)
  const root = createRoot(container)
  const Shell = () => React.createElement('div', null, [
    ...regs['sidebar.footer.action'].map((C, i) => React.createElement(C, { key: `s${i}` })),
    ...regs['shell.overlay'].map((C, i) => React.createElement(C, { key: `o${i}` })),
  ])
  await act(async () => { root.render(React.createElement(Shell)) })
  await flush()
  const h = {
    calls, opened, container,
    text: () => container.textContent,
    drawer: () => container.querySelector('[role="dialog"]'),
    button: (re) => [...container.querySelectorAll('button')].find((b) => re.test(b.textContent) || re.test(b.getAttribute('aria-label') ?? '')),
    click: async (el) => { assert.ok(el, 'element to click exists'); await act(async () => { el.dispatchEvent(new win.MouseEvent('click', { bubbles: true })) }); await flush() },
    open: async () => { await h.click(h.button(/^微信$/)) },
    unmount: async () => { await act(async () => root.unmount()); disposers.forEach((d) => d?.()); container.remove() },
  }
  return h
}

const ok = (value) => ({ ok: true, value })
const idleView = { connected: false, loggedInAt: null, lastError: null, login: { active: false }, contacts: [], bots: [], maxBots: 10, qrSvg: null }
const bot = (over) => ({ id: 'bot1@im.bot', name: '微信机器人 bot1', customName: '', defaultName: '微信机器人 bot1', enabled: true, health: 'ok', connected: true, needsRelogin: false, failures: 0, loggedInAt: Date.now(), lastEventAt: Date.now(), lastError: null, lastSendError: null, contacts: [], ...over })
const QR = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="5" height="5"/></svg>'

test('client.js 语法可解析（语法错误会让整个 DSH 页面加载失败）', () => {
  assert.doesNotThrow(() => new Function('window', SOURCE))
})

test('扫码登录：按钮调用 login/start（不再打开 /weixin），并渲染二维码；抽屉是 aria-modal 对话框', async () => {
  const h = await mount((endpoint) => endpoint === 'login/start'
    ? ok({ ...idleView, login: { active: true, status: 'wait', hasQr: true, message: '请用手机微信扫描二维码' }, qrSvg: QR })
    : ok(idleView))
  await h.open()
  assert.equal(h.drawer().getAttribute('aria-modal'), 'true')
  assert.match(h.text(), /未绑定微信机器人/)
  await h.click(h.button(/^扫码绑定微信机器人$/))
  assert.deepEqual(h.opened, [])
  assert.ok(h.calls.some((c) => c.channel === '/dsh-weixin-web' && c.endpoint === 'login/start'))
  const img = h.container.querySelector('img[alt="微信登录二维码"]')
  assert.ok(img, '二维码图片已渲染')
  assert.match(img.getAttribute('src'), /^data:image\/svg\+xml/)
  assert.match(h.text(), /请用手机微信扫描二维码/)
  assert.equal(h.button(/^扫码绑定微信机器人$/), undefined, '扫码进行中不再显示绑定按钮')
  await h.unmount()
})

test('需要验证码：显示输入框，提交时以 payload.code 调用 login/verify', async () => {
  const verifyView = { ...idleView, login: { active: true, status: 'need_verifycode', hasQr: true, message: '手机微信上显示了数字验证码，请在面板输入' }, qrSvg: QR }
  const h = await mount((endpoint) => endpoint === 'login/verify'
    ? ok({ ...idleView, login: { active: true, status: 'wait', hasQr: true, message: '已提交验证码，继续验证…' }, qrSvg: QR, result: { ok: true, message: '验证码已提交' } })
    : ok(verifyView))
  await h.open()
  const input = h.container.querySelector('input[aria-label="手机验证码"]')
  assert.ok(input, '验证码输入框存在')
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set
  await act(async () => { setter.call(input, ' 123456 '); input.dispatchEvent(new win.Event('input', { bubbles: true })) })
  await act(async () => { input.form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true })) })
  await flush()
  const verify = h.calls.find((c) => c.endpoint === 'login/verify')
  assert.ok(verify, '调用了 login/verify')
  assert.deepEqual(verify.payload, { code: '123456' })
  assert.match(h.text(), /已提交验证码/)
  await h.unmount()
})

test('RPC 失败：显示真实错误文本而不是笼统的「操作失败」', async () => {
  const h = await mount((endpoint) => endpoint === 'login/start'
    ? { ok: false, error: { code: 'internal', message: 'get_bot_qrcode HTTP 500: upstream error', details: {} } }
    : ok(idleView))
  await h.open()
  await h.click(h.button(/^扫码绑定微信机器人$/))
  const alert = h.container.querySelector('[role="alert"]')
  assert.ok(alert)
  assert.match(alert.textContent, /get_bot_qrcode HTTP 500: upstream error/)
  await h.unmount()
})

test('机器人连接异常：卡片红色并展示错误；解绑调用 bot/delete', async () => {
  let deleted = false
  const errorBot = bot({ lastError: 'getupdates HTTP 502: Bad Gateway' })
  const h = await mount((endpoint) => {
    if (endpoint === 'bot/delete') { deleted = true; return ok(idleView) }
    return ok(deleted ? idleView : { ...idleView, connected: true, loggedInAt: Date.now(), bots: [errorBot] })
  })
  await h.open()
  assert.match(h.text(), /连接异常，正在重试/)
  assert.match(h.text(), /getupdates HTTP 502/)
  const card = h.container.querySelector('[data-bot]')
  assert.equal(card.querySelector('span[aria-hidden="true"]').style.background, 'rgb(220, 38, 38)')
  await h.click(h.button(/^解绑$/))
  assert.deepEqual(h.calls.find((c) => c.endpoint === 'bot/delete').payload, { botId: 'bot1@im.bot' })
  assert.match(h.text(), /未绑定微信机器人/)
  await h.unmount()
})

test('登录过期的机器人显示「重新扫码」；达到上限时禁用添加按钮', async () => {
  const bots = Array.from({ length: 10 }, (_, i) => bot({ id: `b${i}@im.bot`, name: `机器人${i}` }))
  bots[0] = { ...bots[0], health: 'needs_relogin', needsRelogin: true, connected: false }
  const h = await mount(() => ok({ ...idleView, connected: true, bots }))
  await h.open()
  assert.match(h.text(), /登录已过期，请重新扫码/)
  assert.ok(h.button(/重新扫码 机器人0/))
  assert.equal(h.button(/重新扫码 机器人1/), undefined)
  assert.equal(h.button(/^添加微信机器人$/).disabled, true)
  assert.match(h.text(), /已达上限 10 个/)
  await h.unmount()
})

test('打开时轮询 status、Esc 关闭后停止轮询', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const h = await mount(() => ok(idleView))
    await h.open()
    const count = () => h.calls.filter((c) => c.endpoint === 'status').length
    const before = count()
    mock.timers.tick(2000); await flush()
    mock.timers.tick(2000); await flush()
    assert.ok(count() >= before + 2, `打开期间应继续轮询（${before} → ${count()}）`)
    await act(async () => { win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' })) })
    await flush()
    assert.equal(h.drawer(), null, 'Esc 关闭抽屉')
    const afterClose = count()
    mock.timers.tick(10000); await flush()
    assert.equal(count(), afterClose, '关闭后不再轮询')
    await h.unmount()
  } finally {
    mock.timers.reset()
  }
})

test('统一消息列表：跨机器人列出会话，名字为机器人名，显示预览/时间与总联系人数；点击打开 DSH 会话并收起抽屉', async () => {
  const now = Date.now()
  const opened = []
  const conv = [
    { id: 'u1@im.wechat', sessionId: 's1', name: '无敌最可爱', botId: 'a@im.bot', botName: '无敌最可爱', owner: true, lastMessageAt: now - 5_000, preview: '明天几点开会？', direction: 'inbound', enabled: true, health: 'ok' },
    { id: 'u2@im.wechat', sessionId: 's2', name: '绿茶茶', botId: 'b@im.bot', botName: '绿茶茶', owner: true, lastMessageAt: now - 3_600_000 * 30, preview: '好的', direction: 'outbound', enabled: true, health: 'ok' },
    { id: 'zzzz9999@im.wechat', sessionId: 's3', name: '微信用户 zz9999', botId: 'b@im.bot', botName: '绿茶茶', owner: false, lastMessageAt: null, preview: '', direction: null, enabled: true, health: 'ok' },
  ]
  const h = await mount(() => ok({ ...idleView, connected: true, bots: [bot({ id: 'a@im.bot', name: '无敌最可爱', contacts: [conv[0]] }), bot({ id: 'b@im.bot', name: '绿茶茶', contacts: [conv[1], conv[2]] })], contacts: conv, totalContacts: 3 }),
    { services: { uiWorkspace: { openSession: (id) => opened.push(id) } } })
  await h.open()
  const text = h.text()
  assert.match(text, /共 3 个联系人/)
  assert.match(text, /无敌最可爱/)
  assert.match(text, /明天几点开会？/)
  assert.match(text, /刚刚/)
  assert.match(text, /回复：好的/)
  assert.match(text, /微信用户 zz9999经「绿茶茶」/)
  assert.match(text, /暂无消息记录/)
  assert.match(text, /机器人（2）/)
  assert.doesNotMatch(text, /微信用户 u1/)
  const rows = [...h.container.querySelectorAll('button[data-session]')]
  assert.deepEqual(rows.map((r) => r.dataset.session), ['s1', 's2', 's3'])
  await h.click(rows[0])
  assert.deepEqual(opened, ['s1'])
  assert.equal(h.drawer(), null, '打开会话后收起抽屉')
  await h.unmount()
})

test('统一消息列表：宿主没有 uiWorkspace 时给出可读提示，不报错', async () => {
  const conv = [{ id: 'u1@im.wechat', sessionId: 's1', name: '无敌最可爱', botId: 'a@im.bot', botName: '无敌最可爱', lastMessageAt: Date.now(), preview: 'hi', direction: 'inbound' }]
  const h = await mount(() => ok({ ...idleView, connected: true, bots: [bot({ contacts: conv })], contacts: conv, totalContacts: 1 }))
  await h.open()
  await h.click(h.container.querySelector('button[data-session="s1"]'))
  assert.match(h.container.querySelector('[role="alert"]').textContent, /无法打开会话/)
  await h.unmount()
})

test('机器人卡片：重命名、暂停/恢复、解绑带确认；新绑定后弹出起名卡片', async () => {
  const a = bot({ id: 'a@im.bot', name: '家里', customName: '家里' })
  const b = bot({ id: 'b@im.bot', name: '微信机器人 bbbb', customName: '', health: 'paused', enabled: false, connected: false })
  let view = { ...idleView, connected: true, bots: [a, b], contacts: [{ id: 'u@im.wechat', sessionId: 's1', name: '家里', botId: 'a@im.bot', botName: '家里', lastMessageAt: Date.now(), preview: 'hi', direction: 'inbound' }], totalContacts: 1 }
  const h = await mount((endpoint, payload) => {
    if (endpoint === 'bot/rename') view = { ...view, bots: view.bots.map((x) => x.id === payload.botId ? { ...x, name: payload.name, customName: payload.name } : x), contacts: (view.contacts ?? []).map((c) => c.botId === payload.botId ? { ...c, name: payload.name, botName: payload.name } : c) }
    if (endpoint === 'bot/pause') view = { ...view, bots: view.bots.map((x) => x.id === payload.botId ? { ...x, enabled: false, health: 'paused', connected: false } : x) }
    if (endpoint === 'bot/resume') view = { ...view, bots: view.bots.map((x) => x.id === payload.botId ? { ...x, enabled: true, health: 'ok', connected: true } : x) }
    if (endpoint === 'login/start') view = { ...view, login: { active: true, status: 'confirmed', hasQr: false, message: '登录成功！', botId: 'c@im.bot', isNew: true }, bots: [...view.bots, bot({ id: 'c@im.bot', name: '微信机器人 cccc', customName: '' })] }
    return ok(view)
  })
  await h.open()
  assert.match(h.text(), /家里/)
  assert.match(h.text(), /已暂停/)
  await h.click(h.button(/重命名 家里/))
  const input = h.container.querySelector('input[aria-label="新名字"]')
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set
  await act(async () => { setter.call(input, '家里的助手'); input.dispatchEvent(new win.Event('input', { bubbles: true })) })
  await act(async () => { input.form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true })) })
  await flush()
  assert.deepEqual(h.calls.find((c) => c.endpoint === 'bot/rename').payload, { botId: 'a@im.bot', name: '家里的助手' })
  assert.match(h.text(), /家里的助手/)
  assert.match(h.container.querySelector('section[aria-label="消息"]').textContent, /家里的助手/, '改名后消息列表立即显示新名字')

  await h.click(h.button(/暂停 家里的助手/))
  assert.deepEqual(h.calls.find((c) => c.endpoint === 'bot/pause').payload, { botId: 'a@im.bot' })
  await h.click(h.button(/恢复 家里的助手/))
  assert.deepEqual(h.calls.find((c) => c.endpoint === 'bot/resume').payload, { botId: 'a@im.bot' })

  win.confirm = () => false
  await h.click(h.button(/解绑 家里的助手/))
  assert.equal(h.calls.some((c) => c.endpoint === 'bot/delete'), false, '取消确认不调用解绑')

  await h.click(h.button(/^添加微信机器人$/))
  assert.ok(h.calls.some((c) => c.endpoint === 'login/start'))
  const nameForm = h.container.querySelector('form[aria-label="给新机器人起名"]')
  assert.ok(nameForm, '新绑定后弹出起名卡片')
  const nameInput = nameForm.querySelector('input')
  assert.equal(nameInput.value, '微信机器人 cccc', '预填默认名')
  await h.unmount()
})

test('机器人设置：打开设置读取选项，编辑人设/模型/预设后保存；按联系人开始新对话（带确认）；卡片显示设置摘要', async () => {
  const contact = { id: 'scanner@im.wechat', sessionId: 's1', name: '绿茶茶', botId: 'a@im.bot', botName: '绿茶茶', owner: true }
  let view = { ...idleView, connected: true, bots: [bot({ id: 'a@im.bot', name: '绿茶茶', customName: '绿茶茶', contacts: [contact], settings: { persona: '', model: null, preset: null } })], contacts: [contact], totalContacts: 1 }
  const options = {
    models: [
      { provider: 'deepseek-official', model: 'deepseek-v4-flash', name: 'V4 Flash', providerName: 'DeepSeek', vision: false },
      { provider: 'deepseek-official', model: 'deepseek-v4-vl', name: 'V4 VL', providerName: 'DeepSeek', vision: true },
    ],
    defaultModel: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    presets: [{ id: 'default', name: '默认' }, { id: 'coder', name: '写代码' }],
    defaultPreset: 'default',
    maxPersona: 4000,
  }
  const h = await mount((endpoint, payload) => {
    if (endpoint === 'bot/options') return ok({ ...view, options })
    if (endpoint === 'bot/settings') view = { ...view, bots: view.bots.map((x) => ({ ...x, settings: { persona: payload.persona, model: payload.model, preset: payload.preset } })) }
    if (endpoint === 'bot/new-chat') return ok({ ...view, newChat: { oldSessionId: 's1', sessionId: 's2' } })
    return ok(view)
  })
  await h.open()
  await h.click(h.button(/设置 绿茶茶/))
  assert.deepEqual(h.calls.find((c) => c.endpoint === 'bot/options').payload, { botId: 'a@im.bot' })
  const form = h.container.querySelector('form[aria-label="机器人设置"]')
  assert.ok(form, '设置表单出现')
  const modelSelect = form.querySelector('select[aria-label="模型"]')
  assert.deepEqual([...modelSelect.options].map((o) => o.textContent), ['跟随 DSH 默认（deepseek-v4-flash）', 'V4 Flash · DeepSeek', 'V4 VL · DeepSeek · 可看图'])
  const presetSelect = form.querySelector('select[aria-label="预设"]')
  assert.deepEqual([...presetSelect.options].map((o) => o.value), ['', 'default', 'coder'])
  assert.match(form.textContent, /只对新对话生效/)

  const textarea = form.querySelector('textarea[aria-label="人设"]')
  const setText = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value').set
  const setSelect = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value').set
  await act(async () => { setText.call(textarea, '你叫绿茶茶，说话温柔'); textarea.dispatchEvent(new win.Event('input', { bubbles: true })) })
  await act(async () => { setSelect.call(modelSelect, 'deepseek-official|deepseek-v4-vl'); modelSelect.dispatchEvent(new win.Event('change', { bubbles: true })) })
  await act(async () => { setSelect.call(presetSelect, 'coder'); presetSelect.dispatchEvent(new win.Event('change', { bubbles: true })) })
  assert.match(form.textContent, /10 \/ 4000/)
  await act(async () => { form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true })) })
  await flush()
  assert.deepEqual(h.calls.find((c) => c.endpoint === 'bot/settings').payload, {
    botId: 'a@im.bot', persona: '你叫绿茶茶，说话温柔', model: { provider: 'deepseek-official', model: 'deepseek-v4-vl' }, preset: 'coder',
  })
  assert.equal(h.container.querySelector('form[aria-label="机器人设置"]'), null, '保存后收起')
  assert.match(h.text(), /设置已保存/)
  assert.match(h.container.querySelector('[data-bot="a@im.bot"]').textContent, /人设已设置 · 模型 deepseek-v4-vl · 预设 coder/)

  // 再次打开：预填当前设置；「跟随默认」可恢复
  await h.click(h.button(/设置 绿茶茶/))
  const form2 = h.container.querySelector('form[aria-label="机器人设置"]')
  assert.equal(form2.querySelector('select[aria-label="模型"]').value, 'deepseek-official|deepseek-v4-vl')
  assert.equal(form2.querySelector('textarea').value, '你叫绿茶茶，说话温柔')

  win.confirm = () => false
  await h.click(h.button(/和 绿茶茶 开始新对话/))
  assert.equal(h.calls.some((c) => c.endpoint === 'bot/new-chat'), false, '取消确认不新建')
  win.confirm = () => true
  await h.click(h.button(/和 绿茶茶 开始新对话/))
  assert.deepEqual(h.calls.find((c) => c.endpoint === 'bot/new-chat').payload, { botId: 'a@im.bot', peer: 'scanner@im.wechat' })
  assert.match(h.text(), /已和「绿茶茶」开始新对话/)

  await h.click(h.button(/^取消$/))
  assert.equal(h.container.querySelector('form[aria-label="机器人设置"]'), null)
  await h.unmount()
})
