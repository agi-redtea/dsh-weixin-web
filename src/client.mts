// @ts-nocheck
/** Native DSH web client: mounts a WeChat entry in the host sidebar and overlay. */
export const name = 'dsh-weixin-web-client'
export const inject = ['slots']

export function apply(ctx) {
  const React = globalThis.React
  if (!React) return
  let open = false
  const rerender = () => ctx.emit?.('weixin-web/changed')
  const SidebarEntry = () => React.createElement('button', { className: 'dsh-weixin-entry', onClick: () => { open = true; rerender() } }, '微信')
  const Drawer = () => open ? React.createElement('aside', { className: 'dsh-weixin-drawer' }, [
    React.createElement('header', { key: 'h' }, ['微信', React.createElement('button', { onClick: () => { open = false; rerender() } }, '关闭')]),
    React.createElement('p', { key: 's' }, '连接状态与最近消息将在这里显示'),
  ]) : null
  const stops = []
  stops.push(ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'weixin', order: 90, label: () => '微信' }, SidebarEntry)))
  stops.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'weixin', order: 90, label: () => '微信' }, Drawer)))
  ctx.effect(() => () => stops.forEach((stop) => stop?.()), 'weixin-web-client')
}
