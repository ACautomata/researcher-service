// #799 前端 vitest：FigureCard（AutoFigure web 面图卡，story 50/51，#752 §2.4）。
// 结构：
//   1. 进行态：figure_run.progress 六 stage 阶段条（story 50）；
//   2. 终态：PNG 预览 + 下载 final SVG（story 50）+ 幂等提示（story 51）；
//   3. 异形 details 兜底（≤4KB 截断 / 无 figureId → 原文回退，默认渲染精神）；
//   4. 实时/回放零差异（#730 硬验收延伸）：实时归约产出行与 fromProjection 投影行
//      分别经 ToolLine 挂载，FigureCard DOM 全等。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const getPng = vi.fn()
const getSvg = vi.fn()
vi.mock('@/api/figures', () => ({
  getFigurePngBlob: (...args: unknown[]) => getPng(...args),
  getFigureSvgBlob: (...args: unknown[]) => getSvg(...args),
}))

import ToolLine from '@/components/chat/ToolLine.vue'
import FigureCard from '@plugins/autofigure/components/FigureCard.vue'
import { applyEvent, fromProjection, type Msg, type ToolRow } from '@/chat/projection'
import type { SessionEvent } from '@/chat/useEventStream'

const ev = (type: string, payload: Record<string, unknown> = {}, extra: Partial<SessionEvent> = {}): SessionEvent =>
  ({ type, payload, ...extra })

const DETAILS = '{"figureId":"fig1","state":"completed","previewReady":true}'
const INPUT = '{"method_text":"方法流程图"}'

beforeEach(() => {
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:preview', revokeObjectURL: vi.fn() })
  getPng.mockReset().mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  getSvg.mockReset().mockResolvedValue(new Blob(['<svg/>'], { type: 'image/svg+xml' }))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mountExpanded(tool: ToolRow) {
  const wrapper = mount(ToolLine, { props: { tool } })
  await wrapper.find('summary').trigger('click')
  return wrapper
}

describe('FigureCard 进行态（story 50 阶段条）', () => {
  it('stage=segmenting → 六 stage 全呈现，当前高亮、先前完成', () => {
    const wrapper = mount(FigureCard, {
      props: { details: null, input: INPUT, state: 'running', expanded: true, isPartial: true, stage: 'segmenting', toolCallId: 'f1' },
    })
    const items = wrapper.findAll('[data-test="figure-stage-item"]')
    expect(items).toHaveLength(6)
    // 文本含状态点：done ✓ / active ⟳ / pending 空（六 stage 全呈现，story 50）
    expect(items.map((i) => i.text().replace(/\s+/g, ' ').trim()))
      .toEqual(['✓ 生成', '⟳ 分割', '准备', '模板', '装配', '渲染'])
    expect(items[1].classes()).toContain('active')
    expect(items[0].classes()).toContain('done')
    expect(items[2].classes()).not.toContain('active')
  })

  it('无 stage（progress 未到）→ 泛生成中态，不渲染阶段条', () => {
    const wrapper = mount(FigureCard, {
      props: { details: null, input: INPUT, state: 'running', expanded: true, isPartial: true, toolCallId: 'f1' },
    })
    expect(wrapper.find('[data-test="figure-stage-bar"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="figure-pending"]').exists()).toBe(true)
  })
})

describe('FigureCard 终态（story 50 预览/下载 + story 51 幂等提示）', () => {
  it('previewReady=true → 拉 PNG 预览渲染 <img>', async () => {
    const wrapper = mount(FigureCard, {
      props: { details: DETAILS, input: INPUT, state: 'done', expanded: true, toolCallId: 'f1' },
    })
    await flushPromises()
    expect(getPng).toHaveBeenCalledWith('fig1')
    const img = wrapper.find('[data-test="figure-preview"]')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('blob:preview')
  })

  it('previewReady=false → 直接拉 final SVG 渲染（不走 PNG 端点）', async () => {
    const wrapper = mount(FigureCard, {
      props: { details: '{"figureId":"fig2","state":"completed","previewReady":false}', input: INPUT, state: 'done', expanded: true, toolCallId: 'f1' },
    })
    await flushPromises()
    expect(getPng).not.toHaveBeenCalled()
    expect(getSvg).toHaveBeenCalledWith('fig2', false)
    expect(wrapper.find('[data-test="figure-preview"]').attributes('src')).toBe('blob:preview')
  })

  it('PNG 拉取失败 → 降级拉 SVG 渲染', async () => {
    getPng.mockRejectedValue(new Error('70043'))
    const wrapper = mount(FigureCard, {
      props: { details: DETAILS, input: INPUT, state: 'done', expanded: true, toolCallId: 'f1' },
    })
    await flushPromises()
    expect(getSvg).toHaveBeenCalledWith('fig1', false)
    expect(wrapper.find('[data-test="figure-preview"]').exists()).toBe(true)
  })

  it('拉取全失败 → 占位态；下载按钮仍可点（产物面独立重试）', async () => {
    getPng.mockRejectedValue(new Error('x'))
    getSvg.mockRejectedValue(new Error('x'))
    const wrapper = mount(FigureCard, {
      props: { details: DETAILS, input: INPUT, state: 'done', expanded: true, toolCallId: 'f1' },
    })
    await flushPromises()
    expect(wrapper.find('[data-test="figure-preview"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="figure-missing"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="figure-download"]').exists()).toBe(true)
  })

  it('下载按钮走 SVG 下载面（?download=1）', async () => {
    const wrapper = mount(FigureCard, {
      props: { details: DETAILS, input: INPUT, state: 'done', expanded: true, toolCallId: 'f1' },
    })
    await flushPromises()
    await wrapper.find('[data-test="figure-download"]').trigger('click')
    await flushPromises()
    expect(getSvg).toHaveBeenCalledWith('fig1', true)
  })

  it('终态呈现幂等提示（story 51：同 method_text 复用引用）', () => {
    const wrapper = mount(FigureCard, {
      props: { details: DETAILS, input: INPUT, state: 'done', expanded: true, toolCallId: 'f1' },
    })
    expect(wrapper.find('[data-test="figure-idempotency"]').text()).toContain('复用')
  })

  it('终态不渲染阶段条（stage 为进行态装饰，实时终态行已剥落——零差异前提）', () => {
    const wrapper = mount(FigureCard, {
      props: { details: DETAILS, input: INPUT, state: 'done', expanded: true, stage: 'rendering', toolCallId: 'f1' },
    })
    expect(wrapper.find('[data-test="figure-stage-bar"]').exists()).toBe(false)
  })
})

describe('FigureCard 失败态与兜底', () => {
  it('error 态 → 失败显示', () => {
    const wrapper = mount(FigureCard, {
      props: { details: null, input: INPUT, state: 'error', expanded: true, toolCallId: 'f1' },
    })
    expect(wrapper.find('[data-test="figure-error"]').exists()).toBe(true)
  })

  it('details 异形（截断/无 figureId）→ 原文兜底，不渲染卡面构件', () => {
    const wrapper = mount(FigureCard, {
      props: { details: '{"figureId":"被截断的fi', input: INPUT, state: 'done', expanded: true, toolCallId: 'f1' },
    })
    expect(wrapper.find('[data-test="figure-fallback"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="figure-preview"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="figure-download"]').exists()).toBe(false)
  })
})

describe('FigureCard 实时/回放零差异（#730 硬验收延伸，#752 §8）', () => {
  function liveDoneTool(): Msg['tools'][number] {
    let vm = applyEvent([], ev('run.started', {}, { runId: 'r1' }))
    vm = applyEvent(vm, ev('tool.start', { toolCallId: 'f1', name: 'figure_generate', input: INPUT }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('figure_run.progress', { toolCallId: 'f1', stage: 'rendering' }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('tool.end', { toolCallId: 'f1', state: 'success', durationMs: 4200, details: DETAILS }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('run.completed', {}, { runId: 'r1' }))
    return vm[0].tools[0]
  }

  function replayDoneTool(): Msg['tools'][number] {
    const vm = fromProjection({
      sessionId: 's1', title: 'T',
      messages: [{
        id: 'm2', turn: 2, role: 'assistant', content: '图已生成。', anchorCheckpointId: 'ck-1', createdAt: '2026-10-06T00:00:01Z',
        tools: [{ toolCallId: 'f1', name: 'figure_generate', input: INPUT, state: 'success', durationMs: 4200, details: DETAILS }],
      }],
    })
    return vm[0].tools[0]
  }

  it('实时终态行 ≡ 回放行：两入口经 ToolLine 渲染 FigureCard DOM 全等', async () => {
    const live = await mountExpanded(liveDoneTool())
    const replay = await mountExpanded(replayDoneTool())
    const liveCard = live.find('[data-test="figure-card"]')
    const replayCard = replay.find('[data-test="figure-card"]')
    expect(liveCard.exists()).toBe(true)
    expect(replayCard.exists()).toBe(true)
    expect(liveCard.html()).toBe(replayCard.html())
  })

  it('进行中：实时有 stage 阶段条；刷新回放（inFlight 行无 stage）不渲染阶段条——isPartial 装饰仅实时构造', async () => {
    const live = await mountExpanded({
      id: 'f1', name: 'figure_generate', state: 'running', title: null, input: INPUT, result: null, stage: 'templating',
    })
    expect(live.find('[data-test="figure-stage-bar"]').exists()).toBe(true)

    // 刷新后在飞重建（inFlight 从 checkpoint blob 重建——tools[] 无 stage）
    const replay = await mountExpanded({
      id: 'f1', name: 'figure_generate', state: 'running', title: null, input: INPUT, result: null,
    })
    expect(replay.find('[data-test="figure-stage-bar"]').exists()).toBe(false)
    expect(replay.find('[data-test="figure-pending"]').exists()).toBe(true)
  })
})
