/** UI-only data model shared by the DSH client drawer and host routes. */
export type WeixinMessageDirection = 'inbound' | 'outbound' | 'status'

export interface WeixinTimelineMessage {
  id: string
  at: number
  direction: WeixinMessageDirection
  text: string
}

export interface WeixinConversationSummary {
  userId: string
  displayName: string
  lastMessageAt: number
  preview: string
  unread?: number
}

export interface MinuteGroup {
  key: string
  label: string
  conversations: WeixinConversationSummary[]
}

/**
 * Group contacts by the minute of their latest WeChat message. The result is
 * newest-first and intentionally uses a stable machine key for client refreshes.
 */
export function groupConversationsByMinute(
  conversations: readonly WeixinConversationSummary[],
  locale = 'zh-CN',
): MinuteGroup[] {
  const groups = new Map<string, MinuteGroup>()
  const sorted = [...conversations].sort((a, b) => b.lastMessageAt - a.lastMessageAt)
  for (const conversation of sorted) {
    const date = new Date(conversation.lastMessageAt)
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`
    const label = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
    const group = groups.get(key) ?? { key, label, conversations: [] }
    group.conversations.push(conversation)
    groups.set(key, group)
  }
  return [...groups.values()]
}
