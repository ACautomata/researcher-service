// PlanApprovalCard 测试面分工（S14 收敛，双文件漂移防护）：
//   chatComponents.test.ts —— 展示面契约（#920 §1：标题行/轮次徽标/plan 折叠区/失效态/
//     fail-soft 兜底/plan.text 空串/断线同契约禁用）；
//   本文件 —— reason 交互全量面（#913 · 853 §6.2）+ ApprovalDock 三值透传：
//   1. 批准直点 → resolve 三参、附言位显式 undefined；「添加附言」展开输入后批准 → 第三参
//      携带附言（两框 maxlength=2000 锚属性——钳制是浏览器 UI 层行为，jsdom 编程式 setValue
//      不触发，不虚构截断断言）；
//   2. 「拒绝并说明理由」（spec 853 §5.1 字面文案）滑出必填理由框（空理由禁提交）→
//      [确认拒绝] emit reason / [返回] 收起并清值（C2 拍板：收起即清，重试不带滞留值）；
//   3. ApprovalDock 三值透传：方案卡三参 / 漏斗卡两键仍两参（toStrictEqual 长度锁）。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import ApprovalDock from '@/components/chat/ApprovalDock.vue'
import PlanApprovalCard from '@/components/chat/PlanApprovalCard.vue'
import type { ApprovalItem } from '@/stores/chat'

const PLAN = { title: '实验方案：光降解机理验证', summary: '通过对照实验验证光降解假说。', text: '## 1 任务背景\n验证 **光降解** 假说。', round: 1 }

function item(over: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    id: 'e1', source: 'experiment-plan', toolName: 'experiment_plan', toolCallSummary: '实验方案（第 1/3 轮）',
    teammateId: null, status: 'pending', decision: '', detailOpen: false, seq: 1, plan: { ...PLAN },
    ...over,
  }
}

function mountCard(props: { approval: ApprovalItem; disconnected?: boolean }) {
  return mount(PlanApprovalCard, { props: { disconnected: false, ...props } })
}

describe('PlanApprovalCard reason 交互（#913 · 853 §5.1/§6.2）', () => {
  it('批准直点 → resolve 三参、附言位显式 undefined（无附言随行）', async () => {
    const wrapper = mountCard({ approval: item() })
    await wrapper.find('[data-test="approve-e1"]').trigger('click')
    expect(wrapper.emitted('resolve')).toStrictEqual([[item(), 'allow', undefined]])
  })

  it('附言可选：「添加附言」展开输入（≤2000 钳制）后批准 → 第三参携带附言', async () => {
    const wrapper = mountCard({ approval: item() })
    await wrapper.find('[data-test="note-toggle-e1"]').trigger('click')
    expect(wrapper.find('[data-test="note-input-e1"]').attributes('maxlength')).toBe('2000')
    await wrapper.find('[data-test="note-input-e1"]').setValue('注意对照组数量')
    await wrapper.find('[data-test="approve-e1"]').trigger('click')
    expect(wrapper.emitted('resolve')![0]).toStrictEqual([item(), 'allow', '注意对照组数量'])
  })

  it('附言收起清值（C2 拍板）：展开输入 → 收起再展开 → 批准不带滞留附言', async () => {
    const wrapper = mountCard({ approval: item() })
    await wrapper.find('[data-test="note-toggle-e1"]').trigger('click')
    await wrapper.find('[data-test="note-input-e1"]').setValue('旧附言')
    await wrapper.find('[data-test="note-toggle-e1"]').trigger('click') // 收起
    await wrapper.find('[data-test="note-toggle-e1"]').trigger('click') // 再展开
    await wrapper.find('[data-test="approve-e1"]').trigger('click')
    expect(wrapper.emitted('resolve')![0]).toStrictEqual([item(), 'allow', undefined])
  })

  it('拒绝：「拒绝并说明理由」（853 §5.1 字面文案）滑出必填理由框（≤2000 钳制），空理由禁提交', async () => {
    const wrapper = mountCard({ approval: item() })
    expect(wrapper.find('[data-test="deny-e1"]').text()).toBe('拒绝并说明理由')
    await wrapper.find('[data-test="deny-e1"]').trigger('click')
    expect(wrapper.find('[data-test="deny-input-e1"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="deny-input-e1"]').attributes('maxlength')).toBe('2000')
    expect(wrapper.find('[data-test="deny-confirm-e1"]').attributes('disabled')).toBeDefined()
    await wrapper.find('[data-test="deny-input-e1"]').setValue('样本量不足')
    expect(wrapper.find('[data-test="deny-confirm-e1"]').attributes('disabled')).toBeUndefined()
    await wrapper.find('[data-test="deny-confirm-e1"]').trigger('click')
    expect(wrapper.emitted('resolve')).toStrictEqual([[item(), 'deny', '样本量不足']])
  })

  it('「返回」收起理由框不提交并清值（C2）：再展开输入框为空', async () => {
    const wrapper = mountCard({ approval: item() })
    await wrapper.find('[data-test="deny-e1"]').trigger('click')
    await wrapper.find('[data-test="deny-input-e1"]').setValue('先不拒绝')
    await wrapper.find('[data-test="deny-back-e1"]').trigger('click')
    expect(wrapper.find('[data-test="deny-input-e1"]').exists()).toBe(false)
    expect(wrapper.emitted('resolve')).toBeUndefined()
    await wrapper.find('[data-test="deny-e1"]').trigger('click') // 再展开
    expect((wrapper.find('[data-test="deny-input-e1"]').element as HTMLTextAreaElement).value).toBe('')
  })

  it('resolving / disconnected → 操作禁用（#920 §1 既有面不回退）', () => {
    expect(mountCard({ approval: item({ status: 'resolving' }) }).find('[data-test="approve-e1"]').attributes('disabled')).toBeDefined()
    expect(mountCard({ approval: item(), disconnected: true }).find('[data-test="approve-e1"]').attributes('disabled')).toBeDefined()
  })
})

describe('ApprovalDock 三值透传（#913 reason 链末端）', () => {
  it('方案卡 resolve 三值透传；漏斗卡两键仍两参（toStrictEqual 长度锁）', async () => {
    const funnelItem = item({ id: 'e2', source: 'judge-limit', toolName: 'bash', toolCallSummary: 'rm -rf x', plan: undefined })
    const wrapper = mount(ApprovalDock, { props: { approvals: [item(), funnelItem], disconnected: false } })
    expect(wrapper.find('[data-test="approval-e1"]').exists()).toBe(true) // 方案卡（#920 §1 分流）
    expect(wrapper.find('[data-test^="approval-e2"]').exists()).toBe(true) // 漏斗卡原样

    await wrapper.find('[data-test="deny-e1"]').trigger('click')
    await wrapper.find('[data-test="deny-input-e1"]').setValue('样本量不足')
    await wrapper.find('[data-test="deny-confirm-e1"]').trigger('click')
    expect(wrapper.emitted('resolve')![0]).toStrictEqual([item(), 'deny', '样本量不足']) // 三参

    await wrapper.find('[data-test="approve-e2"]').trigger('click')
    expect(wrapper.emitted('resolve')![1]).toStrictEqual([funnelItem, 'allow']) // 两参（长度锁）
    await wrapper.find('[data-test="deny-e2"]').trigger('click')
    expect(wrapper.emitted('resolve')![2]).toStrictEqual([funnelItem, 'deny']) // 两参（长度锁）
  })
})
