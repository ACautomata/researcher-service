// seam: chatStore —— 对话响应式投影（#316 候选 B / #340 验收：纯 mutation 单测）。
// 覆盖：消息投影纯 mutation、审批卡去重/权威落定/recover、切容器/会话清态、斜杠命令态。
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore, newMsg } from '@/stores/chat'

describe('chatStore 纯 mutation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('pushMessage / finalizeLast：流式占位落定（streaming/thinkingOpen 清）', () => {
    const chat = useChatStore()
    chat.pushMessage(newMsg('user', 'hi'))
    chat.pushMessage(newMsg('assistant'))
    expect(chat.messages[1].streaming).toBe(true)
    chat.finalizeLast()
    expect(chat.messages[1].streaming).toBe(false)
    expect(chat.messages[1].thinkingOpen).toBe(false)
  })

  it('addApproval 幂等去重 + resolveApproval 权威落定（unknown 兜底）', () => {
    const chat = useChatStore()
    chat.addApproval({ id: 'a1', kind: 'exec', command: 'rm -rf /tmp/x', sessionKey: null })
    chat.addApproval({ id: 'a1', kind: 'exec', command: 'dup', sessionKey: null }) // 幂等
    expect(chat.approvals.length).toBe(1)
    expect(chat.approvals[0].status).toBe('pending')
    chat.resolveApproval('a1', 'allow-once')
    expect(chat.approvals[0].status).toBe('resolved')
    expect(chat.approvals[0].decision).toBe('allow-once')
    // 未知权威值 → unknown（前端不显示「已批准」）
    chat.addApproval({ id: 'a2', kind: 'exec', command: 'x', sessionKey: null })
    chat.resolveApproval('a2', 'expired')
    expect(chat.approvals[1].decision).toBe('unknown')
  })

  it('addApproval 赋全局单调递增 seq（先到者小）；幂等去重不推进', () => {
    const chat = useChatStore()
    chat.addApproval({ id: 'a1', kind: 'exec', command: 'x', sessionKey: null })
    chat.addApproval({ id: 'a2', kind: 'exec', command: 'y', sessionKey: 'sk-1' })
    chat.addApproval({ id: 'a1', kind: 'exec', command: 'dup', sessionKey: null }) // 幂等：不新赋 seq
    expect(chat.approvals.map((a) => a.seq)).toEqual([1, 2])
  })

  it('seqCounter 随切容器重置（与审批卡清空同生命周期）', () => {
    const chat = useChatStore()
    chat.addApproval({ id: 'a1', kind: 'exec', command: 'x', sessionKey: null })
    chat.resetForContainer()
    chat.addApproval({ id: 'a2', kind: 'exec', command: 'y', sessionKey: null })
    expect(chat.approvals.map((a) => a.seq)).toEqual([1])
  })

  it('切会话不清空审批卡（留存按 sessionKey 过滤）→ seq 继续递增不撞序', () => {
    const chat = useChatStore()
    chat.addApproval({ id: 'old', kind: 'exec', command: 'x', sessionKey: 'sk-1' })
    chat.resetForSession() // 只清消息/分页态，不碰审批卡
    chat.addApproval({ id: 'fresh', kind: 'exec', command: 'y', sessionKey: null })
    expect(chat.approvals.map((a) => a.seq)).toEqual([1, 2])
  })

  it('recoverPendingApprovals：仅复位匹配卡（无 id → 全部）', () => {
    const chat = useChatStore()
    chat.addApproval({ id: 'a1', kind: 'exec', command: 'x', sessionKey: null })
    chat.addApproval({ id: 'a2', kind: 'exec', command: 'y', sessionKey: null })
    chat.approvals[0].status = 'resolving'
    chat.approvals[1].status = 'resolving'
    chat.recoverPendingApprovals('a1')
    expect(chat.approvals[0].status).toBe('pending')
    expect(chat.approvals[1].status).toBe('resolving')
    chat.recoverPendingApprovals()
    expect(chat.approvals[1].status).toBe('pending')
  })

  it('resetForContainer：清会话/消息/审批/命令/输入/分页态', () => {
    const chat = useChatStore()
    chat.setSessions([{ session_key: 'sk-1', title: '', updated_at: '' }])
    chat.setSelectedSession('sk-1')
    chat.pushMessage(newMsg('assistant'))
    chat.addApproval({ id: 'a1', kind: 'exec', command: 'x', sessionKey: null })
    chat.setCommands([{ name: 'cmd', description: 'd', aliases: ['/cmd'] }])
    chat.setInput('/')
    chat.setHistoryState(true, 'anchor-1', false)
    chat.resetForContainer()
    expect(chat.sessions).toEqual([])
    expect(chat.selectedSession).toBe('')
    expect(chat.messages).toEqual([])
    expect(chat.approvals).toEqual([])
    expect(chat.commands).toEqual([])
    expect(chat.input).toBe('')
    expect(chat.historyHasMore).toBe(false)
    expect(chat.historyAnchor).toBeNull()
  })

  it('会话 CRUD mutation：prependSession / removeSession / setSelectedSession', () => {
    const chat = useChatStore()
    chat.prependSession({ session_key: 'sk-1', title: 't', updated_at: '' })
    chat.prependSession({ session_key: 'sk-2', title: '', updated_at: '' })
    expect(chat.sessions.map((s) => s.session_key)).toEqual(['sk-2', 'sk-1'])
    chat.removeSession('sk-1')
    expect(chat.sessions.map((s) => s.session_key)).toEqual(['sk-2'])
  })
})
