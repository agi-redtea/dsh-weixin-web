/* DSH browser client. This file is intentionally a single ModuleLoader module. */
window.__ModuleLoader__.load({
  id: 'dsh-weixin-web',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var React = require('react')
    var h = React.createElement
    var useEffect = React.useEffect
    var useReducer = React.useReducer
    var useRef = React.useRef
    var CHANNEL = '/dsh-weixin-web'
    var POLL_MS = 2000
    var rpc = null

    var state = { open: false, view: null, error: '', busy: '', code: '', adding: false, editing: null, editName: '', naming: null, namedFor: {} }
    var listeners = new Set()
    function update(patch) {
      state = Object.assign({}, state, patch)
      listeners.forEach(function (listener) { listener() })
    }
    function usePanelState() {
      var force = useReducer(function (value) { return value + 1 }, 0)[1]
      useEffect(function () {
        listeners.add(force)
        return function () { listeners.delete(force) }
      }, [force])
      return state
    }

    /** 新绑定的机器人：登录确认后弹出起名卡片（每个机器人只弹一次）。 */
    function notePrompt(value) {
      var login = (value && value.login) || {}
      if (login.status === 'confirmed' && login.isNew && login.botId && !state.namedFor[login.botId]) {
        var bot = (value.bots || []).filter(function (b) { return b.id === login.botId })[0]
        var namedFor = Object.assign({}, state.namedFor)
        namedFor[login.botId] = true
        return { naming: { botId: login.botId, name: bot ? bot.name : '' }, namedFor: namedFor, adding: false }
      }
      return null
    }

    /** 调用宿主 RPC；成功时刷新面板视图并返回 value，失败时把真实错误写进面板并返回 null。 */
    function call(endpoint, payload) {
      if (!rpc) { update({ error: 'DSH 连接尚未就绪，请稍后重试' }); return Promise.resolve(null) }
      return Promise.resolve()
        .then(function () { return rpc.call(CHANNEL, endpoint, payload || {}) })
        .then(function (response) {
          var result = response && response.result ? response.result : response
          if (!result || result.ok !== true) {
            throw new Error(result && result.error && result.error.message ? result.error.message : '微信服务调用失败（' + endpoint + '）')
          }
          var value = result.value || {}
          var patch = Object.assign({ view: value, error: '' }, notePrompt(value) || {})
          if (value.result && value.result.ok === false) patch.error = value.result.message || '操作失败'
          update(patch)
          return value
        })
        .catch(function (error) {
          update({ error: (error && error.message) || String(error) })
          return null
        })
    }
    var statusInFlight = false
    function loadStatus() {
      if (statusInFlight) return Promise.resolve(null)
      statusInFlight = true
      return call('status').then(function (value) { statusInFlight = false; return value })
    }
    function act(endpoint, payload, busyKey) {
      update({ busy: busyKey || endpoint, error: '' })
      return call(endpoint, payload).then(function (value) { update({ busy: '' }); return value })
    }
    function startLogin() { update({ adding: true }); return act('login/start') }
    function submitCode() {
      var code = String(state.code || '').trim()
      if (!code) { update({ error: '请输入手机微信上显示的数字验证码' }); return Promise.resolve(null) }
      return act('login/verify', { code: code }).then(function (value) {
        if (value && !(value.result && value.result.ok === false)) update({ code: '' })
        return value
      })
    }
    function renameBot(botId, name) {
      return act('bot/rename', { botId: botId, name: String(name || '').trim() }, 'bot/rename:' + botId).then(function (value) {
        if (value) update({ editing: null, editName: '', naming: state.naming && state.naming.botId === botId ? null : state.naming })
        return value
      })
    }
    function pauseBot(bot) { return act('bot/pause', { botId: bot.id }, 'bot/pause:' + bot.id) }
    function resumeBot(bot) { return act('bot/resume', { botId: bot.id }, 'bot/resume:' + bot.id) }
    function deleteBot(bot) {
      if (typeof window.confirm === 'function' && !window.confirm('解绑「' + bot.name + '」？解绑后该机器人不再接收和回复微信消息，已有会话会保留。')) return Promise.resolve(null)
      return act('bot/delete', { botId: bot.id }, 'bot/delete:' + bot.id)
    }
    function close() { update({ open: false }) }

    var HEALTH = {
      ok: { tone: 'ok', text: '已连接' },
      retrying: { tone: 'error', text: '连接异常，正在重试' },
      needs_relogin: { tone: 'error', text: '登录已过期，请重新扫码' },
      stopped: { tone: 'error', text: '未运行' },
      paused: { tone: 'idle', text: '已暂停' },
      logged_out: { tone: 'idle', text: '未登录' }
    }
    function botState(bot) {
      var s = HEALTH[bot.health] || HEALTH.stopped
      if (bot.health === 'ok' && bot.lastError) s = HEALTH.retrying
      return s
    }

    /** 侧边栏圆点与登录卡片的总体状态：tone 决定颜色（ok 绿 / pending 黄 / error 红 / idle 灰）。 */
    function describe(view, error) {
      if (!view) return error ? { tone: 'error', title: '无法读取微信状态' } : { tone: 'idle', title: '正在读取微信状态…' }
      var login = view.login || {}
      if (login.active && login.status !== 'confirmed') {
        var failed = login.status === 'error' || login.status === 'expired'
        return { tone: failed ? 'error' : 'pending', title: login.message || '正在登录…' }
      }
      var bots = view.bots || []
      if (!bots.length) return { tone: 'idle', title: '未绑定微信机器人' }
      if (bots.some(function (b) { return botState(b).tone === 'error' && b.enabled !== false })) return { tone: 'error', title: '有机器人需要处理' }
      if (bots.some(function (b) { return b.connected })) return { tone: 'ok', title: '已连接' }
      return { tone: 'idle', title: '全部已暂停' }
    }
    var TONE = { ok: '#16a34a', pending: '#f59e0b', error: '#dc2626', idle: '#9ca3af' }

    function pad(n) { return (n < 10 ? '0' : '') + n }
    function formatTime(at) {
      if (!at) return ''
      var d = new Date(at)
      var diff = Date.now() - at
      if (diff >= 0 && diff < 60000) return '刚刚'
      var hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
      var now = new Date()
      if (d.toDateString() === now.toDateString()) return hm
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm
    }

    var btn = { padding: '9px 12px', border: 0, borderRadius: '8px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }
    var small = { padding: '5px 9px', borderRadius: '7px', cursor: 'pointer', fontWeight: 600, fontSize: '12px', background: 'transparent', color: 'inherit', border: '1px solid var(--ds-border, #d1d5db)' }
    var primary = Object.assign({}, btn, { background: '#2563eb', color: '#fff' })
    var secondary = Object.assign({}, btn, { background: 'transparent', color: 'inherit', border: '1px solid var(--ds-border, #d1d5db)' })
    var smallDanger = Object.assign({}, small, { color: '#dc2626', border: '1px solid #fca5a5' })
    var muted = { color: 'var(--ds-text-secondary, #6b7280)', fontSize: '12px' }
    var inputStyle = { minWidth: 0, flex: 1, padding: '7px 9px', border: '1px solid var(--ds-border, #d1d5db)', borderRadius: '8px', fontSize: '13px', background: 'transparent', color: 'inherit' }
    var card = { border: '1px solid var(--ds-border, #e7e9ee)', borderRadius: '10px', padding: '12px 14px', marginBottom: '12px' }

    function Dot(props) {
      return h('span', { 'aria-hidden': true, style: { width: props.size || '9px', height: props.size || '9px', borderRadius: '50%', flexShrink: 0, background: TONE[props.tone] } })
    }
    function ChatIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.4A8 8 0 1 1 21 12z' }))
    }
    function SidebarEntry() {
      var panel = usePanelState()
      var tone = describe(panel.view, panel.error).tone
      return h('button', {
        type: 'button',
        'aria-haspopup': 'dialog',
        onClick: function () { update({ open: true }); loadStatus() },
        style: { width: '100%', border: 0, background: 'transparent', color: 'inherit', padding: '9px 12px', display: 'flex', gap: '9px', alignItems: 'center', cursor: 'pointer', fontSize: '14px', textAlign: 'left' }
      }, [
        h(ChatIcon, { key: 'icon' }),
        h('span', { key: 'label', style: { flex: 1 } }, '微信'),
        panel.view || panel.error ? h(Dot, { key: 'dot', tone: tone, size: '7px' }) : null
      ])
    }
    function ContactRow(props) {
      var c = props.contact
      var preview = c.preview ? (c.direction === 'outbound' ? '回复：' : '') + c.preview : '已建立会话，本次运行暂无消息记录'
      return h('div', { style: { padding: '8px 0', borderTop: '1px solid var(--ds-border, #e7e9ee)' } }, [
        h('div', { key: 'top', style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' } }, [
          h('div', { key: 'name', title: c.id, style: { fontWeight: 600, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.name || c.nickname || c.id || '微信联系人'),
          c.lastMessageAt ? h('div', { key: 'time', style: Object.assign({ flexShrink: 0 }, muted) }, formatTime(c.lastMessageAt)) : null
        ]),
        h('div', { key: 'detail', style: Object.assign({ marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, muted) }, preview)
      ])
    }
    /** 扫码区：二维码 / 验证码 / 进度提示。只在登录进行中或刚结束时显示。 */
    function LoginBlock(props) {
      var panel = props.panel
      var view = panel.view || {}
      var login = view.login || {}
      var busy = !!panel.busy
      if (!login.active && !panel.adding) return null
      var children = []
      var info = describe(view, '')
      if (login.active) {
        children.push(h('div', { key: 'line', role: 'status', style: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 } }, [
          h(Dot, { key: 'dot', tone: login.status === 'confirmed' ? 'ok' : info.tone }),
          h('span', { key: 'text' }, login.message || '正在登录…')
        ]))
      }
      if (view.qrSvg && login.status !== 'need_verifycode') {
        children.push(h('img', { key: 'qr', src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(view.qrSvg), alt: '微信登录二维码', style: { display: 'block', width: '224px', maxWidth: '100%', height: 'auto', margin: '12px auto 0', background: '#fff', padding: '8px', borderRadius: '8px', boxSizing: 'border-box' } }))
        children.push(h('div', { key: 'hint', style: Object.assign({ marginTop: '8px', textAlign: 'center' }, muted) }, '用要绑定的微信号打开「扫一扫」，扫描后在手机上确认'))
      }
      if (login.active && login.status === 'need_verifycode') {
        children.push(h('form', {
          key: 'verify',
          onSubmit: function (event) { event.preventDefault(); submitCode() },
          style: { marginTop: '12px', display: 'flex', gap: '8px' }
        }, [
          h('input', { key: 'input', 'aria-label': '手机验证码', value: panel.code, inputMode: 'numeric', autoComplete: 'one-time-code', autoFocus: true, placeholder: '手机上显示的验证码', onChange: function (event) { update({ code: event.target.value }) }, style: inputStyle }),
          h('button', { key: 'submit', type: 'submit', disabled: busy, style: primary }, panel.busy === 'login/verify' ? '提交中…' : '提交')
        ]))
      }
      var finished = !login.active || login.status === 'error' || login.status === 'expired' || login.status === 'confirmed'
      if (finished) {
        var retry = login.status === 'error' || login.status === 'expired'
        children.push(h('div', { key: 'actions', style: { marginTop: '12px', display: 'flex', gap: '8px' } }, [
          retry ? h('button', { key: 'retry', type: 'button', disabled: busy, onClick: startLogin, style: Object.assign({ flex: 1 }, primary) }, '重新生成二维码') : null,
          h('button', { key: 'done', type: 'button', onClick: function () { update({ adding: false }) }, style: Object.assign({ flex: 1 }, secondary) }, '收起')
        ]))
      }
      if (!children.length) return null
      return h('div', { style: Object.assign({}, card, { borderColor: info.tone === 'error' ? '#fca5a5' : 'var(--ds-border, #e7e9ee)' }) }, children)
    }
    /** 新机器人起名卡片：默认名预填，可直接保存或跳过。 */
    function NamePrompt(props) {
      var panel = props.panel
      var naming = panel.naming
      if (!naming) return null
      var busy = panel.busy === 'bot/rename:' + naming.botId
      return h('form', {
        'aria-label': '给新机器人起名',
        onSubmit: function (event) { event.preventDefault(); renameBot(naming.botId, naming.name) },
        style: Object.assign({}, card, { borderColor: '#93c5fd' })
      }, [
        h('div', { key: 'title', style: { fontWeight: 700, fontSize: '14px' } }, '绑定成功！给这个机器人起个名字'),
        h('div', { key: 'sub', style: Object.assign({ marginTop: '4px' }, muted) }, '名字会出现在会话标题「微信·名字」里，方便区分不同微信号。'),
        h('div', { key: 'row', style: { marginTop: '10px', display: 'flex', gap: '8px' } }, [
          h('input', { key: 'input', 'aria-label': '机器人名字', value: naming.name, maxLength: 32, autoFocus: true, onChange: function (event) { update({ naming: { botId: naming.botId, name: event.target.value } }) }, style: inputStyle }),
          h('button', { key: 'save', type: 'submit', disabled: busy, style: primary }, busy ? '保存中…' : '保存'),
          h('button', { key: 'skip', type: 'button', onClick: function () { update({ naming: null }) }, style: secondary }, '跳过')
        ])
      ])
    }
    function BotCard(props) {
      var panel = props.panel
      var bot = props.bot
      var s = botState(bot)
      var busy = !!panel.busy
      var editing = panel.editing === bot.id
      var contacts = bot.contacts || []
      var meta = ['联系人 ' + contacts.length]
      if (bot.lastEventAt && bot.enabled !== false) meta.push('最近同步 ' + formatTime(bot.lastEventAt))
      var children = [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
          h(Dot, { key: 'dot', tone: s.tone }),
          h('div', { key: 'name', title: bot.id, style: { fontWeight: 700, fontSize: '14px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, bot.name),
          h('span', { key: 'state', style: Object.assign({ flexShrink: 0 }, muted, s.tone === 'error' ? { color: '#dc2626' } : {}) }, s.text)
        ]),
        h('div', { key: 'meta', style: Object.assign({ marginTop: '4px' }, muted) }, meta.join(' · '))
      ]
      if (bot.lastError && bot.enabled !== false) children.push(h('div', { key: 'err', style: { marginTop: '6px', color: '#dc2626', fontSize: '12px', wordBreak: 'break-word' } }, bot.lastError))
      if (bot.lastSendError && bot.lastSendError.message) children.push(h('div', { key: 'send', style: { marginTop: '6px', color: '#dc2626', fontSize: '12px', wordBreak: 'break-word' } }, '最近一次回复发送失败：' + bot.lastSendError.message))
      if (editing) {
        children.push(h('form', {
          key: 'rename',
          'aria-label': '重命名机器人',
          onSubmit: function (event) { event.preventDefault(); renameBot(bot.id, panel.editName) },
          style: { marginTop: '10px', display: 'flex', gap: '6px' }
        }, [
          h('input', { key: 'input', 'aria-label': '新名字', value: panel.editName, maxLength: 32, autoFocus: true, placeholder: bot.defaultName, onChange: function (event) { update({ editName: event.target.value }) }, style: inputStyle }),
          h('button', { key: 'save', type: 'submit', disabled: busy, style: small }, panel.busy === 'bot/rename:' + bot.id ? '保存中…' : '保存'),
          h('button', { key: 'cancel', type: 'button', onClick: function () { update({ editing: null, editName: '' }) }, style: small }, '取消')
        ]))
      } else {
        var actions = [
          h('button', { key: 'rename', type: 'button', disabled: busy, 'aria-label': '重命名 ' + bot.name, onClick: function () { update({ editing: bot.id, editName: bot.customName || bot.name }) }, style: small }, '重命名')
        ]
        if (bot.needsRelogin || bot.health === 'stopped') {
          actions.push(h('button', { key: 'relogin', type: 'button', disabled: busy, 'aria-label': '重新扫码 ' + bot.name, onClick: startLogin, style: small }, '重新扫码'))
        }
        if (bot.enabled === false) {
          actions.push(h('button', { key: 'resume', type: 'button', disabled: busy, 'aria-label': '恢复 ' + bot.name, onClick: function () { resumeBot(bot) }, style: small }, panel.busy === 'bot/resume:' + bot.id ? '恢复中…' : '恢复'))
        } else {
          actions.push(h('button', { key: 'pause', type: 'button', disabled: busy, 'aria-label': '暂停 ' + bot.name, onClick: function () { pauseBot(bot) }, style: small }, panel.busy === 'bot/pause:' + bot.id ? '暂停中…' : '暂停'))
        }
        actions.push(h('button', { key: 'delete', type: 'button', disabled: busy, 'aria-label': '解绑 ' + bot.name, onClick: function () { deleteBot(bot) }, style: smallDanger }, panel.busy === 'bot/delete:' + bot.id ? '解绑中…' : '解绑'))
        children.push(h('div', { key: 'actions', style: { marginTop: '10px', display: 'flex', gap: '6px', flexWrap: 'wrap' } }, actions))
      }
      if (contacts.length) {
        children.push(h('div', { key: 'contacts', style: { marginTop: '8px' } }, contacts.map(function (contact, index) { return h(ContactRow, { key: contact.id || index, contact: contact }) })))
      }
      return h('div', { 'data-bot': bot.id, style: Object.assign({}, card, s.tone === 'error' ? { borderColor: '#fca5a5', background: 'rgba(220,38,38,.04)' } : {}) }, children)
    }
    function Drawer() {
      var panel = usePanelState()
      var closeRef = useRef(null)
      useEffect(function () {
        if (!panel.open) return undefined
        loadStatus()
        var timer = setInterval(loadStatus, POLL_MS)
        function onKey(event) { if (event.key === 'Escape') close() }
        window.addEventListener('keydown', onKey)
        if (closeRef.current && closeRef.current.focus) closeRef.current.focus()
        return function () { clearInterval(timer); window.removeEventListener('keydown', onKey) }
      }, [panel.open])
      if (!panel.open) return null
      var view = panel.view || {}
      var bots = view.bots || []
      var maxBots = view.maxBots || 10
      var login = view.login || {}
      var loginRunning = login.active && (login.status === 'wait' || login.status === 'scaned' || login.status === 'need_verifycode')
      var full = bots.length >= maxBots
      var body = []
      if (!panel.view && !panel.error) body.push(h('div', { key: 'loading', role: 'status', style: muted }, '正在读取微信状态…'))
      if (panel.error) body.push(h('div', { key: 'error', role: 'alert', style: { marginBottom: '12px', color: '#dc2626', fontSize: '12px', wordBreak: 'break-word' } }, panel.error))
      body.push(h(NamePrompt, { key: 'naming', panel: panel }))
      body.push(h(LoginBlock, { key: 'login', panel: panel }))
      if (panel.view && !bots.length && !login.active) {
        body.push(h('div', { key: 'empty', role: 'status', style: Object.assign({}, card, { lineHeight: 1.6 }) }, [
          h('div', { key: 't', style: { fontWeight: 600, display: 'flex', gap: '8px', alignItems: 'center' } }, [h(Dot, { key: 'd', tone: 'idle' }), h('span', { key: 's' }, '未绑定微信机器人')]),
          h('div', { key: 'd', style: Object.assign({ marginTop: '4px' }, muted) }, '扫码绑定后，微信消息会进入 DSH「微信」工作区的会话并自动回复。')
        ]))
      }
      bots.forEach(function (bot) { body.push(h(BotCard, { key: bot.id, bot: bot, panel: panel })) })
      if (panel.view && !loginRunning) {
        body.push(h('div', { key: 'add', style: { marginTop: '4px' } }, [
          h('button', { key: 'btn', type: 'button', disabled: !!panel.busy || full, onClick: startLogin, style: Object.assign({ width: '100%' }, primary, full ? { opacity: 0.6, cursor: 'default' } : {}) },
            panel.busy === 'login/start' ? '正在生成二维码…' : (bots.length ? '添加微信机器人' : '扫码绑定微信机器人')),
          h('div', { key: 'hint', style: Object.assign({ marginTop: '6px', textAlign: 'center' }, muted) }, full ? '已达上限 ' + maxBots + ' 个，请先解绑不用的机器人' : '已绑定 ' + bots.length + ' / ' + maxBots + ' 个；每个微信号对应一个机器人')
        ]))
      }
      return h('div', { style: { position: 'fixed', inset: 0, zIndex: 1000, pointerEvents: 'none' } }, [
        h('div', { key: 'shade', onClick: close, style: { position: 'absolute', inset: 0, background: 'rgba(15,23,42,.12)', pointerEvents: 'auto' } }),
        h('aside', { key: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dsh-weixin-title', style: { position: 'absolute', top: 0, right: 0, width: '380px', maxWidth: '100vw', height: '100%', background: 'var(--ds-background, #fff)', color: 'var(--ds-text, #171717)', boxShadow: '-10px 0 28px rgba(15,23,42,.16)', padding: '20px', boxSizing: 'border-box', pointerEvents: 'auto', overflowY: 'auto' } }, [
          h('div', { key: 'header', style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '16px' } }, [
            h('div', { key: 'title' }, [h('div', { key: 'h', id: 'dsh-weixin-title', style: { fontWeight: 700, fontSize: '18px' } }, '微信机器人'), h('div', { key: 'sub', style: Object.assign({ marginTop: '4px' }, muted) }, '绑定、改名、暂停或解绑微信机器人')]),
            h('button', { key: 'close', ref: closeRef, type: 'button', onClick: close, 'aria-label': '关闭', title: '关闭（Esc）', style: { width: '40px', height: '40px', margin: '-8px -8px 0 0', border: 0, borderRadius: '8px', background: 'transparent', cursor: 'pointer', fontSize: '24px', lineHeight: 1, color: 'inherit' } }, '×')
          ]),
          h('div', { key: 'body' }, body)
        ])
      ])
    }
    module.exports = {
      name: 'dsh-weixin-web',
      inject: ['slots', 'connection'],
      apply: function (ctx) {
        rpc = ctx.connection && ctx.connection.rpc
        var stops = []
        try {
          stops.push(ctx.slots.inject('sidebar.footer.action', function () {
            return ctx.slots.register({ name: 'sidebar.footer.action', id: 'weixin', order: 90, label: function () { return '微信' } }, SidebarEntry)
          }))
          stops.push(ctx.slots.inject('shell.overlay', function () {
            return ctx.slots.register({ name: 'shell.overlay', id: 'weixin', order: 90, label: function () { return '微信' } }, Drawer)
          }))
        } catch (error) {
          console.error('[dsh-weixin-web] cannot register DSH slots', error)
        }
        loadStatus()
        ctx.effect(function () {
          return function () {
            stops.forEach(function (stop) { if (typeof stop === 'function') stop() })
            rpc = null
            update({ open: false })
          }
        }, 'dsh-weixin-web-client')
      }
    }
    return module.exports
  }
})
