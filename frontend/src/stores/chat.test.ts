// seam: chatStore —— 对话响应式投影（#316 候选 B / #340 验收：纯 mutation 单测）。
// 覆盖：消息投影纯 mutation、审批卡去重/权威落定/recover、切容器/会话清态、斜杠命令态、
// #405-T1 visibleApprovals 过滤（subagent 会话恒空 + 归属卡显示 + 留存不变量）。
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

  it('#405-T1: addApproval 携带 agentId（幂等去重不重挂 agentId）', () => {
    const chat = useChatStore()
    chat.addApproval({ id: 'a1', kind: 'exec', command: 'x', sessionKey: null, agentId: 'sub-1' })
    // 幂等：同 id 再次到达（实时推送 vs 补拉）→ 已有卡不重挂，agentId 保持首达值
    chat.addApproval({ id: 'a1', kind: 'exec', command: 'x', sessionKey: null, agentId: null })
    expect(chat.approvals).toHaveLength(1)
    expect(chat.approvals[0].agentId).toBe('sub-1')
    // 无 agentId（主会话审批）→ 存储为 null
    chat.addApproval({ id: 'a2', kind: 'exec', command: 'y', sessionKey: 'sk-1' })
    expect(chat.approvals[1].agentId).toBeNull()
  })

  it('#405-T1: visibleApprovals——当前会话非 subagent 时显示归属卡（含无 sessionKey 连接级 + subagent 卡）', () => {
    const chat = useChatStore()
    chat.setSelectedSession('sk-main')
    chat.addApproval({ id: 'own', kind: 'exec', command: 'x', sessionKey: 'sk-main', agentId: null })
    chat.addApproval({ id: 'conn', kind: 'exec', command: 'y', sessionKey: null, agentId: null })
    chat.addApproval({ id: 'other', kind: 'exec', command: 'z', sessionKey: 'sk-other', agentId: null })
    // subagent 卡（sessionKey 是 subagent 形态 + agentId 标识）：纯 sessionKey 匹配永不可达，
    // 依 isSubagentApproval 分支恒在 main 框可见（唯一家语义）
    chat.addApproval({ id: 'sub', kind: 'exec', command: 'w', sessionKey: 'agent:sub-agent-1:subagent:child-1', agentId: 'sub-1' })
    expect(chat.visibleApprovals.map((a) => a.id)).toEqual(['own', 'conn', 'sub'])
  })

  it('#405-T1: visibleApprovals——当前会话是 subagent（#394 实测形态 agent:<id>:subagent:）→ 审批区恒空', () => {
    const chat = useChatStore()
    chat.setSelectedSession('agent:sub-agent-1:subagent:child-1')
    // 归属 subagent 会话的卡（按 sessionKey 归属）与连接级卡在 subagent 会话一律不显示
    chat.addApproval({ id: 'own', kind: 'exec', command: 'x', sessionKey: 'agent:sub-agent-1:subagent:child-1', agentId: null })
    chat.addApproval({ id: 'conn', kind: 'exec', command: 'y', sessionKey: null, agentId: null })
    chat.addApproval({ id: 'sub', kind: 'exec', command: 'w', sessionKey: 'agent:sub-agent-1:subagent:child-1', agentId: 'sub-1' })
    expect(chat.visibleApprovals).toEqual([])
    // 留存不变量：卡仍在 approvals 列表，仅渲染层隐藏（切回 main 可见可回覆）
    expect(chat.approvals).toHaveLength(3)
  })

  it('#405-T1: visibleApprovals——主会话带 agent: 头不误判（前缀匹配有误报）', () => {
    const chat = useChatStore()
    // 主会话 sessionKey 也可带 agent: 头（#394 实测主会话形态 agent:<id>，非 subagent 前缀）
    chat.setSelectedSession('agent:main')
    chat.addApproval({ id: 'own', kind: 'exec', command: 'x', sessionKey: 'agent:main', agentId: null })
    expect(chat.visibleApprovals.map((a) => a.id)).toEqual(['own'])
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
