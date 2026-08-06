// seam: timeline —— 双列表（messages + approvals）渲染期合并为单一时间线（ADR 0009 / #397 / #399）。
// #405-T2（#407）：可选 anchorState（是否有待展示审批卡）——main 会话还没有任何助手消息时，
// 时间线尾部合成 SyntheticAnchor 虚拟气泡承载审批卡（卡全 resolved 后仍留存，时间线不跳动）。
// 好测试标准：只测外部行为——给定 messages[] + approvals[] + anchorState，合并出的时间线顺序正确。
// 不 assert seqCounter 内部值、不测滚动内部实现。与 eventTranslate.test.ts 并列的纯函数测试最高接缝。
import { describe, expect, it } from 'vitest'
import { newMsg, type ApprovalItem, type Msg } from '@/stores/chat'
import { isSyntheticAnchor, mergeTimeline } from '@/chat/timeline'

// ---- 测试工厂 ----

function mkApproval(partial: Partial<ApprovalItem> & { id: string }): ApprovalItem {
  return {
    kind: 'exec',
    command: 'rm -rf /tmp/x',
    sessionKey: null,
    agentId: null,
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

// ---- #405-T2（#407）：SyntheticAnchor 虚拟气泡（main 无 assistant 消息时承载审批卡）----
describe('mergeTimeline anchorState（#405-T2 合成虚拟气泡）', () => {
  it('无 assistant 消息 + anchorState=true → 尾部合成 SyntheticAnchor 承载审批卡', () => {
    const out = mergeTimeline([user], [toolA], true)
    expect(out.length).toBe(3)
    const anchor = out[1]
    expect(isSyntheticAnchor(anchor)).toBe(true) // 变体判别守卫
    expect(out[2]).toBe(toolA) // 卡承载于虚拟气泡之后
    expect(out[0]).toBe(user)
  })

  it('anchorState=true 但无待展示卡 → 不合成虚拟气泡（anchorState 与卡数量须同真）', () => {
    expect(mergeTimeline([user], [], true)).toEqual([user])
  })

  it('无 assistant 消息 + anchorState=false → 不合成，卡仍插末尾（旧行为）', () => {
    expect(mergeTimeline([user], [toolA], false)).toEqual([user, toolA])
  })

  it('无 assistant + anchorState=true + 多条卡：锚在最前、卡按 seq 序其后', () => {
    const late = mkApproval({ id: 'a3', seq: 3 })
    const out = mergeTimeline([user], [toolB, late, toolA], true)
    expect(isSyntheticAnchor(out[1])).toBe(true)
    expect(out.slice(2)).toEqual([toolA, toolB, late])
  })

  it('有已落定 assistant 气泡 → 即使 anchorState=true 也不合成虚拟气泡', () => {
    const settled = settledAssistant('回答')
    expect(mergeTimeline([user, settled], [toolA], true)).toEqual([user, toolA, settled])
  })

  it('有流式占位 → 即使 anchorState=true 也不合成虚拟气泡（占位即落点）', () => {
    const streaming = newMsg('assistant')
    expect(mergeTimeline([user, streaming], [toolA], true)).toEqual([user, toolA, streaming])
  })

  it('虚拟气泡在卡全 resolved 后仍留存（时间线不跳动）：anchorState 不因卡状态改变', () => {
    const resolved = mkApproval({ id: 'a1', seq: 1, status: 'resolved', decision: 'allow-once' })
    const out = mergeTimeline([user], [resolved], true)
    expect(isSyntheticAnchor(out[1])).toBe(true)
    expect(out[2]).toBe(resolved) // resolved 卡仍承载于锚内
  })

  it('agentId 不参与锚点计算：带/不带 agentId 的卡同序（锚定只看 seq）', () => {
    const sub = mkApproval({ id: 's1', seq: 1, agentId: 'sub-agent-7' }) // subagent 发起卡
    const main = mkApproval({ id: 'm2', seq: 2 }) // main 审批（agentId null）
    const out = mergeTimeline([user], [main, sub], true)
    expect(isSyntheticAnchor(out[1])).toBe(true)
    expect(out.slice(2)).toEqual([sub, main]) // seq 序，与 agentId 无关
  })

  it('anchorState 缺省（undefined）→ 旧行为：无 assistant 时不合成', () => {
    expect(mergeTimeline([user], [toolA])).toEqual([user, toolA])
  })

  it('messages 数组零改动（#340 消息/审批分离）：anchorState=true 不触碰输入数组', () => {
    const input = [user]
    const before = JSON.stringify(input)
    mergeTimeline(input, [toolA], true)
    expect(JSON.stringify(input)).toBe(before)
  })
})
