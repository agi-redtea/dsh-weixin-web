// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import { groupConversationsByMinute } from '../src/ui-model.mjs'

test('按最新微信消息分钟分组，且保持最新联系人优先', () => {
  const base = new Date(2026, 8, 22, 14, 32, 45).getTime()
  const groups = groupConversationsByMinute([
    { userId: 'a', displayName: '小王', lastMessageAt: base, preview: '你好' },
    { userId: 'b', displayName: '林然', lastMessageAt: base - 20_000, preview: '在吗' },
    { userId: 'c', displayName: '陈晨', lastMessageAt: base - 61_000, preview: '收到' },
  ])
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].conversations.map((item) => item.userId), ['a', 'b'])
  assert.deepEqual(groups[1].conversations.map((item) => item.userId), ['c'])
})
