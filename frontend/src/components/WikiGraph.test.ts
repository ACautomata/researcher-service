// seam: WikiGraph 组件 —— wiki 关系图谱（spec §9.6 / issue #45 graph）。
// 覆盖：由 graph 数据组装 vis-network 节点/边、当前页节点高亮、点节点冒泡 open 进编辑器。
// vis-network 需 canvas（jsdom 无），用 vi.mock 替身，专注组件的数据组装与点击转发（seam）。
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface MockItem {
  id: string
  color?: unknown
  borderWidth?: number
  from?: string
  to?: string
}

interface MockDataSet {
  get(): MockItem[]
  getIds(): string[]
  updateCalls: MockItem[][]
}

// vis-network canvas 渲染替身：捕获 DataSet、构造/销毁次数与 click handler
const netState = {
  nodeData: null as MockDataSet | null,
  edgeData: null as MockDataSet | null,
  clickHandler: null as ((p: { nodes: string[] }) => void) | null,
  constructorCount: 0,
  destroyCount: 0,
}
vi.mock('vis-network', () => ({
  Network: class {
    constructor(_el: unknown, data: { nodes: unknown; edges: unknown }) {
      netState.constructorCount += 1
      netState.nodeData = data.nodes as MockDataSet
      netState.edgeData = data.edges as MockDataSet
    }
    on(event: string, cb: (p: { nodes: string[] }) => void): void {
      if (event === 'click') netState.clickHandler = cb
    }
    destroy(): void { netState.destroyCount += 1 }
  },
}))
vi.mock('vis-data', () => ({
  DataSet: class {
    private items = new Map<string, MockItem>()
    updateCalls: MockItem[][] = []

    constructor(items: MockItem[]) {
      this.update(items)
      this.updateCalls = []
    }

    get(): MockItem[] { return [...this.items.values()] }
    getIds(): string[] { return [...this.items.keys()] }
    update(items: MockItem | MockItem[]): void {
      const entries = Array.isArray(items) ? items : [items]
      this.updateCalls.push(entries)
      for (const item of entries) {
        this.items.set(item.id, { ...this.items.get(item.id), ...item })
      }
    }
    remove(ids: string | string[]): void {
      for (const id of Array.isArray(ids) ? ids : [ids]) this.items.delete(id)
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
    netState.nodeData = null
    netState.edgeData = null
    netState.clickHandler = null
    netState.constructorCount = 0
    netState.destroyCount = 0
  })

  it('builds vis-network nodes/edges from graph data', async () => {
    mount(WikiGraph, { props: { graph: GRAPH, activePath: '' } })
    await flushPromises()
    const ids = netState.nodeData?.get().map((n) => n.id) ?? []
    expect(ids).toContain('concepts/a.md')
    expect(ids).toContain('concepts/b.md')
    expect(netState.edgeData?.get()).toEqual([
      expect.objectContaining({ from: 'concepts/a.md', to: 'concepts/b.md' }),
    ])
  })

  it('updates only active-node styles without rebuilding the network', async () => {
    const wrapper = mount(WikiGraph, { props: { graph: GRAPH, activePath: 'concepts/a.md' } })
    await flushPromises()
    await wrapper.setProps({ activePath: 'concepts/b.md' })
    await flushPromises()

    expect(netState.constructorCount).toBe(1)
    expect(netState.destroyCount).toBe(0)
    expect(netState.nodeData?.updateCalls.at(-1)).toEqual([
      { id: 'concepts/a.md', color: undefined, borderWidth: 1 },
      { id: 'concepts/b.md', color: '#409eff', borderWidth: 3 },
    ])
    const nodes = netState.nodeData?.get() ?? []
    expect(nodes.find((n) => n.id === 'concepts/a.md')?.color).toBeUndefined()
    expect(nodes.find((n) => n.id === 'concepts/b.md')?.color).toBe('#409eff')
  })

  it('updates labels and edges in place while the node set is unchanged', async () => {
    const wrapper = mount(WikiGraph, { props: { graph: GRAPH, activePath: '' } })
    await flushPromises()
    await wrapper.setProps({
      graph: {
        nodes: GRAPH.nodes.map((node) =>
          node.id === 'concepts/a.md' ? { ...node, title: 'A updated' } : node,
        ),
        edges: [{ from: 'concepts/b.md', to: 'ghost-node' }],
      },
    })
    await flushPromises()

    expect(netState.constructorCount).toBe(1)
    expect(netState.destroyCount).toBe(0)
    expect(netState.nodeData?.get().find((n) => n.id === 'concepts/a.md')).toEqual(
      expect.objectContaining({ label: 'A updated' }),
    )
    expect(netState.edgeData?.get()).toEqual([
      expect.objectContaining({ from: 'concepts/b.md', to: 'ghost-node' }),
    ])
  })

  it('rebuilds only when the node set changes', async () => {
    const wrapper = mount(WikiGraph, { props: { graph: GRAPH, activePath: '' } })
    await flushPromises()
    await wrapper.setProps({
      graph: {
        nodes: [...GRAPH.nodes, { id: 'concepts/c.md', title: 'C' }],
        edges: GRAPH.edges,
      },
    })
    await flushPromises()

    expect(netState.constructorCount).toBe(2)
    expect(netState.destroyCount).toBe(1)
  })

  it('emits open when a node is clicked', async () => {
    const wrapper = mount(WikiGraph, { props: { graph: GRAPH, activePath: '' } })
    await flushPromises()
    netState.clickHandler?.({ nodes: ['concepts/b.md'] })
    expect(wrapper.emitted('open')).toEqual([['concepts/b.md']])
  })
})
