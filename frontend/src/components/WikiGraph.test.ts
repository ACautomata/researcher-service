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
}
vi.mock('vis-network', () => ({
  Network: class {
    constructor(_el: unknown, data: { nodes: unknown; edges: unknown }) {
      netState.nodes = (data.nodes as { get(): unknown[] }).get() as typeof netState.nodes
      netState.edges = (data.edges as { get(): unknown[] }).get() as typeof netState.edges
    }
    on(event: string, cb: (p: { nodes: string[] }) => void): void {
      if (event === 'click') netState.clickHandler = cb
    }
    destroy(): void {}
  },
}))
vi.mock('vis-data', () => ({
  DataSet: class {
    private items: unknown[]
    constructor(items: unknown[]) { this.items = items }
    get(): unknown[] { return this.items }
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
})
