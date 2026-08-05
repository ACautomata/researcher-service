// seam: timeline —— 双列表（messages + approvals）渲染期合并为单一时间线（ADR 0009 / #397 / #399）。
// 好测试标准：只测外部行为——给定 messages[] + approvals[]，合并出的时间线顺序正确。不 assert
// seqCounter 内部值、不测滚动内部实现。与 eventTranslate.test.ts 并列的纯函数测试最高接缝。
import { describe, expect, it } from 'vitest'
import { newMsg, type ApprovalItem, type Msg } from '@/stores/chat'
import { mergeTimeline } from '@/chat/timeline'

// ---- 测试工厂 ----

function mkApproval(partial: Partial<ApprovalItem> & { id: string }): ApprovalItem {
  return {
    kind: 'exec',
    command: 'rm -rf /tmp/x',
    sessionKey: null,
    status: 'pending',
    decision: '',
    detailOpen: false,
    seq: 0,
    ...partial,
  }
}

// 已落定 assistant 气泡（streaming=false）
function settledAssistant(raw: string, tools?: Msg['tools']): Msg {
  const m = newMsg('assistant', raw)
  m.streaming = false
  if (tools) m.tools = tools
  return m
}

// 有工具行的已落定 assistant（工具行挂 run 内，不扁平化）
function settledWithTool(raw: string): Msg {
  return settledAssistant(raw, [{ id: 't1', name: 'bash', state: 'done', title: null, input: 'ls', result: '' }])
}

const user = newMsg('user', 'hi')
const toolA = mkApproval({ id: 'a1', seq: 1 })
const toolB = mkApproval({ id: 'a2', seq: 2 })

describe('mergeTimeline', () => {
  it('无审批 → 消息按原序原样返回（含 user + 已落定 assistant）', () => {
    const settled = settledAssistant('回答')
    expect(mergeTimeline([user, settled], [])).toEqual([user, settled])
  })

  it('无 assistant 消息 → 审批卡插末尾', () => {
    expect(mergeTimeline([user], [toolA])).toEqual([user, toolA])
  })

  it('已落定 assistant 气泡在末尾 → 审批卡插该气泡之前', () => {
    const settled = settledAssistant('回答')
    expect(mergeTimeline([user, settled], [toolA])).toEqual([user, toolA, settled])
  })

  it('多条审批卡按 seq 到达先后排列', () => {
    const settled = settledAssistant('回答')
    const late = mkApproval({ id: 'a3', seq: 3 })
    expect(mergeTimeline([user, settled], [toolB, late, toolA])).toEqual([user, toolA, toolB, late, settled])
  })

  it('流式占位强制沉底：seq 更小的卡也插在占位之前', () => {
    const streaming = newMsg('assistant') // streaming=true 的最后一条 assistant
    // a3(seq 3) 在占位（seq 不存在）之后到达，仍强制插在占位之前
    const late = mkApproval({ id: 'a3', seq: 3 })
    expect(mergeTimeline([user, streaming], [late])).toEqual([user, late, streaming])
  })

  it('占位落定后退回普通条目：新卡插在气泡之前', () => {
    const settled = settledAssistant('回答')
    const late = mkApproval({ id: 'a3', seq: 3 })
    expect(mergeTimeline([user, settled], [late])).toEqual([user, late, settled])
  })

  it('流式中多卡：全部插在占位之前，卡间按 seq 序', () => {
    const streaming = newMsg('assistant')
    const late = mkApproval({ id: 'a3', seq: 3 })
    expect(mergeTimeline([user, streaming], [toolB, late, toolA])).toEqual([user, toolA, toolB, late, streaming])
  })

  it('审批插在包含工具的已落定 assistant 气泡之前（工具行仍挂 run 内，不扁平化）', () => {
    const withTool = settledWithTool('回答')
    expect(mergeTimeline([user, withTool], [toolA])).toEqual([user, toolA, withTool])
  })

  it('重连补拉：seq 单调递增 → 补拉卡排所有现有卡之后', () => {
    const settled = settledAssistant('回答')
    const pulled = mkApproval({ id: 'a2', seq: 2 }) // 重连补拉到的卡
    expect(mergeTimeline([user, settled], [toolA, pulled])).toEqual([user, toolA, pulled, settled])
  })

  it('切会话后旧卡留存 + 新卡 seq 不撞序（单调）', () => {
    const settled = settledAssistant('回答')
    const leftover = mkApproval({ id: 'old', seq: 2 }) // 切会话前到达、切后仍留存的卡
    const fresh = mkApproval({ id: 'new', seq: 3 }) // 切会话后新到达的卡（seq 继续递增）
    expect(mergeTimeline([user, settled], [leftover, fresh])).toEqual([user, leftover, fresh, settled])
  })

  it('历史 prepend：旧消息 prepend 到顶部不影响审批卡相对序（seq 不受影响）', () => {
    const older = newMsg('user', '更旧')
    const settled = settledAssistant('回答')
    const late = mkApproval({ id: 'a3', seq: 3 })
    expect(mergeTimeline([older, user, settled], [late])).toEqual([older, user, late, settled])
  })

  it('审批卡不可变：多卡乱序输入不被排序改写，返回新数组', () => {
    const settled = settledAssistant('回答')
    const shuffled = [toolB, toolA] // 乱序（seq 2 在前）
    const before = JSON.stringify(shuffled)
    const out = mergeTimeline([user, settled], shuffled)
    expect(out).not.toBe(shuffled) // 不返回原数组
    expect(JSON.stringify(shuffled)).toBe(before) // 调用方数组未被原地排序
    expect(out).toEqual([user, toolA, toolB, settled]) // 输出按 seq 排序
  })
})
