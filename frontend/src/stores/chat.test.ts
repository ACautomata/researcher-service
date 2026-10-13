// chatStore 纯函数单测：approvalCardFields 0 信任逐字段走查（#783 升级通道形状双路同形构造
// 单点——SSE approval.requested 与投影 approvals[] 重拉两路共用）。#920 §1：experiment-plan
// 审批的 plan 块解析（853 §5.1 卡内容契约）。
import { describe, expect, it } from 'vitest'
import { approvalCardFields } from '@/stores/chat'

const baseEscalation = {
  id: 'e1',
  source: 'judge-limit',
  toolCallId: 'tc1',
  toolName: 'bash',
  toolCallSummary: 'rm -rf /tmp/x',
}

describe('approvalCardFields 基础面', () => {
  it('合法 escalation → 逐字段卡片；非对象/null → null', () => {
    expect(approvalCardFields(baseEscalation, null)).toEqual({
      id: 'e1',
      source: 'judge-limit',
      toolName: 'bash',
      toolCallSummary: 'rm -rf /tmp/x',
      teammateId: null,
    })
    expect(approvalCardFields(null, null)).toBeNull()
    expect(approvalCardFields('x', null)).toBeNull()
    // id / toolName 缺失即拒（resolve 链定位参数 + 卡面标题的硬前提）
    expect(approvalCardFields({ ...baseEscalation, id: '' }, null)).toBeNull()
    expect(approvalCardFields({ ...baseEscalation, toolName: 42 }, null)).toBeNull()
  })

  it('judgeReason 仅字符串形状携带', () => {
    expect(approvalCardFields({ ...baseEscalation, judgeReason: '连续被拒' }, null)?.judgeReason).toBe('连续被拒')
    expect(approvalCardFields({ ...baseEscalation, judgeReason: 7 }, null)).not.toHaveProperty('judgeReason')
  })
})

describe('approvalCardFields plan 块解析（#920 §1 · 853 §5.1）', () => {
  const plan = { title: '实验方案：X', summary: '验证 Y', text: '# 沙箱执行规格\n…', round: 1 }

  it('experiment-plan 审批带合法 plan 块 → 整块透传', () => {
    const card = approvalCardFields(
      { ...baseEscalation, source: 'experiment-plan', toolName: 'experiment_plan', plan },
      null,
    )
    expect(card?.plan).toEqual(plan)
  })

  it('plan 块任一字段非预期形状 → 整块丢弃（fail-soft，不阻断 resolve 链）', () => {
    const esc = { ...baseEscalation, source: 'experiment-plan', toolName: 'experiment_plan' }
    expect(approvalCardFields({ ...esc, plan: null }, null)).not.toHaveProperty('plan')
    expect(approvalCardFields({ ...esc, plan: 'x' }, null)).not.toHaveProperty('plan')
    expect(approvalCardFields({ ...esc, plan: { ...plan, title: 1 } }, null)).not.toHaveProperty('plan')
    expect(approvalCardFields({ ...esc, plan: { ...plan, summary: undefined } }, null)).not.toHaveProperty('plan')
    expect(approvalCardFields({ ...esc, plan: { ...plan, text: 3 } }, null)).not.toHaveProperty('plan')
    expect(approvalCardFields({ ...esc, plan: { ...plan, round: 0 } }, null)).not.toHaveProperty('plan')
    expect(approvalCardFields({ ...esc, plan: { ...plan, round: 1.5 } }, null)).not.toHaveProperty('plan')
  })

  it('无 plan 块的 escalation → 卡片无 plan 键（四漏斗 source 零变化）', () => {
    const card = approvalCardFields(baseEscalation, null)
    expect(card).not.toHaveProperty('plan')
  })
})
