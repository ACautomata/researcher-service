// #913 前端 vitest：ResearchRunCard（research 插件 web 面卡，853 §6.2 / #867 定形）。
// 结构：
//   1. 进行态：workflow·stage 双段徽标（透传纪律——无前端白名单，未知 stage fallback 裸名）；
//      W4 两态（plan-review 方案待审批提示条 / collect 结果对账）；progress 未到通用文案；
//   2. 终态四值：completed（深链 + summary markdown）/ clarify（候选清单纯展示）/
//      approved / plan_review_exhausted（summary 承载 lastReason）；
//   3. 失败态与 details 异形兜底；
//   4. 实时/回放零差异（#730 硬验收延伸）：实时归约产出行与 fromProjection 投影行
//      分别经 ToolLine 挂载，ResearchRunCard DOM 全等。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import ToolLine from '@/components/chat/ToolLine.vue'
import ResearchRunCard from '@plugins/research/components/ResearchRunCard.vue'
import { applyEvent, fromProjection, type ToolRow } from '@/chat/projection'
import type { SessionEvent } from '@/chat/useEventStream'

const ev = (type: string, payload: Record<string, unknown> = {}, extra: Partial<SessionEvent> = {}): SessionEvent =>
  ({ type, payload, ...extra })

const COMPLETED_DETAILS =
  '{"workflow":"hypothesize","status":"completed","artifactPages":[{"path":"idea-cards/dig.md","title":"想法卡：光降解"}],"summary":"生成 **5 个假说**。"}'

function mountCard(over: Partial<InstanceType<typeof ResearchRunCard>['$props']> = {}) {
  return mount(ResearchRunCard, {
    props: {
      details: null,
      input: '{"topic":"光降解"}',
      state: 'running',
      expanded: true,
      isPartial: true,
      toolCallId: 'rw1',
      ...over,
    },
  })
}

describe('ResearchRunCard 进行态（双段徽标，853 §6.2）', () => {
  it('workflow+stage → 双段徽标「假说生成 · 分桶生成中…」', () => {
    const wrapper = mountCard({ stage: 'bucket', workflow: 'hypothesize' })
    const badge = wrapper.find('[data-test="research-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('假说生成 · 分桶生成中…')
  })

  it('未知 stage fallback 裸名；未知 workflow fallback 裸名（透传纪律无白名单）', () => {
    const wrapper = mountCard({ stage: '尚未存在的节点', workflow: 'hypothesize' })
    expect(wrapper.find('[data-test="research-badge"]').text()).toBe('假说生成 · 尚未存在的节点中…')
    const wrapper2 = mountCard({ stage: 'bucket', workflow: 'future-flow' })
    // 嵌套字典（853「workflow→{stage→中文}」）：bucket 仅属 hypothesize 域，未知 workflow 不命中 → 双段皆裸名
    expect(wrapper2.find('[data-test="research-badge"]').text()).toBe('future-flow · bucket中…')
  })

  it('入口面帧无 workflow → 单段徽标（classify=意图识别，GLOSSARY 正典）', () => {
    const wrapper = mountCard({ stage: 'classify' })
    expect(wrapper.find('[data-test="research-badge"]').text()).toBe('意图识别中…')
    const wrapper2 = mountCard({ stage: 'hypothesize' })
    expect(wrapper2.find('[data-test="research-badge"]').text()).toBe('假说生成中…')
  })

  it('W4 awaiting_review：stage=plan-review → 徽标「实验 · 方案待审批」+ 卡内提示条引导 dock', () => {
    const wrapper = mountCard({ stage: 'plan-review', workflow: 'experiment' })
    expect(wrapper.find('[data-test="research-badge"]').text()).toBe('实验 · 方案待审批')
    expect(wrapper.find('[data-test="research-badge-hint"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="research-badge-hint"]').text()).toContain('审批卡')
  })

  it('W4 collect 调用③：input.phase=collect → 徽标「结果对账」（853 字面无前缀，phase 优先于 stage）', () => {
    const wrapper = mountCard({ stage: 'collect', workflow: 'experiment', input: '{"workflow":"experiment","phase":"collect","spec_path":"/lab/specs/x.md"}' })
    expect(wrapper.find('[data-test="research-badge"]').text()).toBe('结果对账')
  })

  it('跨流程重名 stage 各 workflow 域内命中（853 §6.1：extract/validate/persist/summary/resolveInputs 重名已含）', () => {
    expect(mountCard({ stage: 'extract', workflow: 'discover' }).find('[data-test="research-badge"]').text()).toBe('科学问题发现 · 内容解析中…')
    expect(mountCard({ stage: 'validate', workflow: 'hypothesize' }).find('[data-test="research-badge"]').text()).toBe('假说生成 · 结构校验中…')
    expect(mountCard({ stage: 'persist', workflow: 'experiment' }).find('[data-test="research-badge"]').text()).toBe('实验 · 写入 wiki中…')
    expect(mountCard({ stage: 'summary', workflow: 'discover' }).find('[data-test="research-badge"]').text()).toBe('科学问题发现 · 结果汇总中…')
    expect(mountCard({ stage: 'resolveInputs', workflow: 'experiment' }).find('[data-test="research-badge"]').text()).toBe('实验 · 解析输入中…')
  })

  it('progress 未到（无 stage）→ 通用文案「工作流运行中…」，不渲染徽标', () => {
    const wrapper = mountCard()
    expect(wrapper.find('[data-test="research-badge"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="research-pending"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="research-pending"]').text()).toContain('工作流运行中')
  })
})

describe('ResearchRunCard 终态（status 四值面）', () => {
  it('completed：✓ + artifactPages 深链（新标签 noopener + path 编码）+ summary 经 MarkdownRenderer', () => {
    const wrapper = mountCard({ state: 'done', details: COMPLETED_DETAILS })
    expect(wrapper.find('[data-test="research-completed"]').exists()).toBe(true)
    const link = wrapper.find('[data-test="artifact-link"]')
    expect(link.attributes('href')).toBe(`/wiki?path=${encodeURIComponent('idea-cards/dig.md')}`)
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toBe('noopener')
    expect(link.text()).toContain('想法卡：光降解')
    expect(link.text()).toContain('idea-cards/dig.md')
    // summary 走 markdown 渲染（**加粗** → strong 节点，非源码）
    expect(wrapper.find('[data-test="research-summary"]').find('strong').exists()).toBe(true)
  })

  it('clarify：提示条 + question + 候选清单纯展示（无发送通道）', () => {
    const details =
      '{"status":"clarify","artifactPages":[],"clarify":{"status":"clarify","question":"请选择流程","candidates":[{"label":"ingest","name":"知识库深度构建","fit":"把论文入库 wiki"}]}}'
    const wrapper = mountCard({ state: 'done', details })
    expect(wrapper.find('[data-test="research-clarify"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="research-clarify"]').text()).toContain('请选择流程')
    expect(wrapper.find('[data-test="research-clarify"]').text()).toContain('知识库深度构建')
    expect(wrapper.find('[data-test="research-clarify"]').text()).toContain('把论文入库 wiki')
    expect(wrapper.find('button').exists()).toBe(false) // 纯展示——props-in 无发送通道
  })

  it('approved：✓ 呈现 + summary 承载 spec 路径（不加 details 字段）', () => {
    const details =
      '{"workflow":"experiment","status":"approved","artifactPages":[],"summary":"实验方案已批准（spec：/lab/specs/dig.md）。"}'
    const wrapper = mountCard({ state: 'done', details })
    expect(wrapper.find('[data-test="research-approved"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="research-approved"]').text()).toContain('/lab/specs/dig.md')
  })

  it('plan_review_exhausted：⚠ 呈现 + summary 承载 lastReason（run completed 非错误面）', () => {
    const details =
      '{"workflow":"experiment","status":"plan_review_exhausted","artifactPages":[],"summary":"实验方案 3 轮审批未通过。最后一轮拒绝理由：样本量不足"}'
    const wrapper = mountCard({ state: 'done', details })
    expect(wrapper.find('[data-test="research-exhausted"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="research-exhausted"]').text()).toContain('样本量不足')
    expect(wrapper.find('[data-test="research-error"]').exists()).toBe(false) // 非错误面
  })

  it('终态不渲染进行态徽标（stage/workflow 为进行态装饰，终态行已剥落——零差异前提）', () => {
    const wrapper = mountCard({ state: 'done', details: COMPLETED_DETAILS, stage: 'summary', workflow: 'hypothesize' })
    expect(wrapper.find('[data-test="research-badge"]').exists()).toBe(false)
  })
})

describe('ResearchRunCard 失败态与兜底', () => {
  it('error 态 → 通用错误面（failed 走 ToolRow state=error，不入 status 值域）', () => {
    const wrapper = mountCard({ state: 'error' })
    expect(wrapper.find('[data-test="research-error"]').exists()).toBe(true)
  })

  it('details 异形（截断/未知 status）→ 原文兜底，不渲染卡面构件', () => {
    const wrapper = mountCard({ state: 'done', details: '{"status":"被截断的st' })
    expect(wrapper.find('[data-test="research-fallback"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="research-completed"]').exists()).toBe(false)
    const unknown = mountCard({ state: 'done', details: '{"status":"mystery","artifactPages":[]}' })
    expect(unknown.find('[data-test="research-fallback"]').exists()).toBe(true)
  })
})

describe('ResearchRunCard 实时/回放零差异（#730 硬验收延伸）', () => {
  function liveDoneTool(): ToolRow {
    let vm = applyEvent([], ev('run.started', {}, { runId: 'r1' }))
    vm = applyEvent(vm, ev('tool.start', { toolCallId: 'rw1', name: 'research_workflow', input: '{"topic":"光降解"}' }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('research_run.progress', { toolCallId: 'rw1', stage: 'bucket', workflow: 'hypothesize' }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('tool.end', { toolCallId: 'rw1', state: 'success', durationMs: 88000, details: COMPLETED_DETAILS }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('run.completed', {}, { runId: 'r1' }))
    return vm[0].tools[0]
  }

  function replayDoneTool(): ToolRow {
    const vm = fromProjection({
      sessionId: 's1', title: 'T',
      messages: [{
        id: 'm2', turn: 2, role: 'assistant', content: '假说已生成。', anchorCheckpointId: 'ck-1', createdAt: '2026-10-13T00:00:01Z',
        tools: [{ toolCallId: 'rw1', name: 'research_workflow', input: '{"topic":"光降解"}', state: 'success', durationMs: 88000, details: COMPLETED_DETAILS }],
      }],
    })
    return vm[0].tools[0]
  }

  async function mountExpanded(tool: ToolRow) {
    const wrapper = mount(ToolLine, { props: { tool } })
    await wrapper.find('summary').trigger('click')
    return wrapper
  }

  it('实时终态行 ≡ 回放行：两入口经 ToolLine 渲染 ResearchRunCard DOM 全等', async () => {
    const live = await mountExpanded(liveDoneTool())
    const replay = await mountExpanded(replayDoneTool())
    const liveCard = live.find('[data-test="research-card"]')
    const replayCard = replay.find('[data-test="research-card"]')
    expect(liveCard.exists()).toBe(true)
    expect(replayCard.exists()).toBe(true)
    expect(liveCard.html()).toBe(replayCard.html())
  })

  it('进行中：实时行带 stage+workflow 双段徽标；刷新回放（inFlight 行无装饰）落通用文案', async () => {
    const live = await mountExpanded({ id: 'rw1', name: 'research_workflow', state: 'running', title: null, input: '{}', result: null, stage: 'bucket', workflow: 'hypothesize' })
    expect(live.find('[data-test="research-badge"]').text()).toBe('假说生成 · 分桶生成中…')

    const replay = await mountExpanded({ id: 'rw1', name: 'research_workflow', state: 'running', title: null, input: '{}', result: null })
    expect(replay.find('[data-test="research-badge"]').exists()).toBe(false)
    expect(replay.find('[data-test="research-pending"]').exists()).toBe(true)
  })
})
