// seam: WikiGraph 组件 —— wiki 关系图谱（spec §9.6 / issue #45 graph）。
// 覆盖：由 graph 数据组装 vis-network 节点/边、当前页节点高亮、点节点冒泡 open 进编辑器。
// vis-network 需 canvas（jsdom 无），用 vi.mock 替身，专注组件的数据组装与点击转发（seam）。
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vis-network canvas 渲染替身：捕获构造的 nodes/edges 与 click handler
const netState = {
  nodes: [] as Array<{ id: string; color?: unknown }>,
  edges: [] as Array<{ from: string; to: string }>,
  clickHandler: null as ((p: { nodes: string[] }) => void) | null,
  // issue #202 问题5：spy 构造/销毁次数，验证高亮切换不重建 Network
  constructCount: 0,
  destroyCount: 0,
  updates: [] as Array<Array<{ id: string; color?: unknown; borderWidth?: number }>>,
}
vi.mock('vis-network', () => ({
  Network: class {
    constructor(_el: unknown, data: { nodes: unknown; edges: unknown }) {
      netState.constructCount += 1
      netState.nodes = (data.nodes as { get(): unknown[] }).get() as typeof netState.nodes
      netState.edges = (data.edges as { get(): unknown[] }).get() as typeof netState.edges
    }
    on(event: string, cb: (p: { nodes: string[] }) => void): void {
      if (event === 'click') netState.clickHandler = cb
    }
    destroy(): void {
      netState.destroyCount += 1
    }
  },
}))
vi.mock('vis-data', () => ({
  DataSet: class {
    private items: unknown[]
    constructor(items: unknown[]) { this.items = items }
    get(): unknown[] { return this.items }
    update(items: unknown[]): void {
      netState.updates.push(items as typeof netState.updates[number])
    }
  },
}))

import WikiGraph from '@/components/WikiGraph.vue'
import type { WikiGraphDTO } from '@/api/wiki'

const GRAPH: WikiGraphDTO = {
  nodes: [
    { id: 'concepts/a.md', title: 'A' },
    { id: 'concepts/b.md', title: 'B' },
    { id: 'ghost-node', title: 'ghost-node', ghost: true },
  ],
  edges: [{ from: 'concepts/a.md', to: 'concepts/b.md' }],
}

describe('WikiGraph', () => {
  beforeEach(() => {
    netState.nodes = []
    netState.edges = []
    netState.clickHandler = null
    netState.constructCount = 0
    netState.destroyCount = 0
    netState.updates = []
  })

  it('builds vis-network nodes/edges from graph data', async () => {
    mount(WikiGraph, { props: { graph: GRAPH, activePath: '' } })
    await flushPromises()
    const ids = netState.nodes.map((n) => n.id)
    expect(ids).toContain('concepts/a.md')
    expect(ids).toContain('concepts/b.md')
    expect(netState.edges).toEqual([{ from: 'concepts/a.md', to: 'concepts/b.md' }])
  })

  it('highlights the active node', async () => {
    mount(WikiGraph, { props: { graph: GRAPH, activePath: 'concepts/a.md' } })
    await flushPromises()
    const active = netState.nodes.find((n) => n.id === 'concepts/a.md')
    const other = netState.nodes.find((n) => n.id === 'concepts/b.md')
    expect(active?.color).toBeTruthy()
    expect(other?.color).toBeFalsy()
  })

  it('emits open when a node is clicked', async () => {
    const wrapper = mount(WikiGraph, { props: { graph: GRAPH, activePath: '' } })
    await flushPromises()
    netState.clickHandler?.({ nodes: ['concepts/b.md'] })
    expect(wrapper.emitted('open')).toEqual([['concepts/b.md']])
  })

  it('activePath change updates highlight incrementally without rebuilding Network (issue #202 问题5)', async () => {
    const wrapper = mount(WikiGraph, { props: { graph: GRAPH, activePath: 'concepts/a.md' } })
    await flushPromises()
    expect(netState.constructCount).toBe(1)

    // 切换高亮节点 → 仅 DataSet.update 增量更新两个节点，不 destroy/重建 Network
    await wrapper.setProps({ activePath: 'concepts/b.md' })
    await flushPromises()
    expect(netState.constructCount).toBe(1)
    expect(netState.destroyCount).toBe(0)
    expect(netState.updates.length).toBeGreaterThan(0)
    const last = netState.updates.at(-1)!
    const ids = last.map((u) => u.id)
    expect(ids).toContain('concepts/a.md') // 旧高亮还原
    expect(ids).toContain('concepts/b.md') // 新高亮强调
    expect(last.find((u) => u.id === 'concepts/b.md')?.color).toBeTruthy()
    expect(last.find((u) => u.id === 'concepts/a.md')?.color).toBeFalsy()
  })

  it('graph structure change still rebuilds Network', async () => {
    const wrapper = mount(WikiGraph, { props: { graph: GRAPH, activePath: '' } })
    await flushPromises()
    expect(netState.constructCount).toBe(1)
    // 图谱数据本身变化（保存后刷新）→ 结构可能变化，整图重建
    await wrapper.setProps({
      graph: { nodes: [...GRAPH.nodes, { id: 'concepts/c.md', title: 'C' }], edges: GRAPH.edges },
    })
    await flushPromises()
    expect(netState.constructCount).toBe(2)
    expect(netState.destroyCount).toBe(1)
  })
})
