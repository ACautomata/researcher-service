// #913 前端 vitest：PlanApprovalCard reason 交互面（#920 §1 展示面已由其测试锁定——
// chatComponents.test.ts PlanApprovalCard describe + stores/chat.test.ts plan 块解析）。
// 本文件锁 #913 独有增量：
//   1. [批准并执行] 直点 → resolve 两值无第三参；「添加附言」展开后批准 → 第三参携带附言
//     （server sessionApprovalSchema reason ≤2000 已支持，附言/理由框均钳 maxlength）；
//   2. [拒绝] 点击滑出必填理由框（空理由禁提交）→ [确认拒绝] emit reason / [返回] 收起；
//   3. ApprovalDock 三值透传（漏斗卡两键仍两参，方案卡三参）。
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
  it('批准直点 → resolve 两值无第三参', async () => {
    const wrapper = mountCard({ approval: item() })
    await wrapper.find('[data-test="approve-e1"]').trigger('click')
    expect(wrapper.emitted('resolve')).toEqual([[item(), 'allow', undefined]])
  })

  it('附言可选：「添加附言」展开输入（≤2000 钳制）后批准 → 第三参携带附言', async () => {
    const wrapper = mountCard({ approval: item() })
    await wrapper.find('[data-test="note-toggle-e1"]').trigger('click')
    expect(wrapper.find('[data-test="note-input-e1"]').attributes('maxlength')).toBe('2000')
    await wrapper.find('[data-test="note-input-e1"]').setValue('注意对照组数量')
    await wrapper.find('[data-test="approve-e1"]').trigger('click')
    expect(wrapper.emitted('resolve')![0]).toEqual([item(), 'allow', '注意对照组数量'])
  })

  it('拒绝：点击滑出必填理由框（≤2000 钳制）+ 确认拒绝/返回；空理由禁提交', async () => {
    const wrapper = mountCard({ approval: item() })
    await wrapper.find('[data-test="deny-e1"]').trigger('click')
    expect(wrapper.find('[data-test="deny-input-e1"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="deny-input-e1"]').attributes('maxlength')).toBe('2000')
    expect(wrapper.find('[data-test="deny-confirm-e1"]').attributes('disabled')).toBeDefined()
    await wrapper.find('[data-test="deny-input-e1"]').setValue('样本量不足')
    expect(wrapper.find('[data-test="deny-confirm-e1"]').attributes('disabled')).toBeUndefined()
    await wrapper.find('[data-test="deny-confirm-e1"]').trigger('click')
    expect(wrapper.emitted('resolve')).toEqual([[item(), 'deny', '样本量不足']])
  })

  it('「返回」收起理由框不提交', async () => {
    const wrapper = mountCard({ approval: item() })
    await wrapper.find('[data-test="deny-e1"]').trigger('click')
    await wrapper.find('[data-test="deny-input-e1"]').setValue('先不拒绝')
    await wrapper.find('[data-test="deny-back-e1"]').trigger('click')
    expect(wrapper.find('[data-test="deny-input-e1"]').exists()).toBe(false)
    expect(wrapper.emitted('resolve')).toBeUndefined()
  })

  it('resolving / disconnected → 操作禁用（#920 §1 既有面不回退）', () => {
    expect(mountCard({ approval: item({ status: 'resolving' }) }).find('[data-test="approve-e1"]').attributes('disabled')).toBeDefined()
    expect(mountCard({ approval: item(), disconnected: true }).find('[data-test="approve-e1"]').attributes('disabled')).toBeDefined()
  })
})

describe('ApprovalDock 三值透传（#913 reason 链末端）', () => {
  it('方案卡 resolve 三值透传；漏斗卡两键仍两参', async () => {
    const funnelItem = item({ id: 'e2', source: 'judge-limit', toolName: 'bash', toolCallSummary: 'rm -rf x', plan: undefined })
    const wrapper = mount(ApprovalDock, { props: { approvals: [item(), funnelItem], disconnected: false } })
    expect(wrapper.find('[data-test="approval-e1"]').exists()).toBe(true) // 方案卡（#920 §1 分流）
    expect(wrapper.find('[data-test^="approval-e2"]').exists()).toBe(true) // 漏斗卡原样

    await wrapper.find('[data-test="deny-e1"]').trigger('click')
    await wrapper.find('[data-test="deny-input-e1"]').setValue('样本量不足')
    await wrapper.find('[data-test="deny-confirm-e1"]').trigger('click')
    expect(wrapper.emitted('resolve')![0]).toHaveLength(3)
  })
})
