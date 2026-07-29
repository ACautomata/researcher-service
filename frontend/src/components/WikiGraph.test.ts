// seam: WikiGraph 组件 —— wiki 关系图谱（spec §9.6 / issue #45 graph）。
// 覆盖：由 graph 数据组装 vis-network 节点/边、当前页节点高亮、点节点冒泡 open 进编辑器。
// issue #202 问题5：activePath 高亮/标题变化走 DataSet.update 增量更新（不重建 Network），
// 仅结构（节点/边集合）变化才 destroy + 重建。
// vis-network 需 canvas（jsdom 无），用 vi.mock 替身，专注组件的数据组装与点击转发（seam）。
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vis-network canvas 渲染替身：捕获构造的 nodes/edges、click handler、构造次数（重建断言）
const netState = {
  nodes: [] as Array<{ id: string; color?: unknown }>,
  edges: [] as Array<{ id: string; from: string; to: string }>,
  clickHandler: null as ((p: { nodes: string[] }) => void) | null,
  constructed: 0, // Network 构造次数：activePath 变化不得 +1（#202 问题5）
  updates: 0, // DataSet.update 调用条目数：增量路径断言
}
vi.mock('vis-network', () => ({
  Network: class {
    constructor(_el: unknown, data: { nodes: unknown; edges: unknown }) {
      netState.constructed += 1
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
    private items: Array<Record<string, unknown>>
    constructor(items: Array<Record<string, unknown>>) { this.items = items }
    get(): unknown[] { return this.items } // 返回活引用：update 后颜色变化经同一数组可见
    update(updates: Array<Record<string, unknown>>): void {
      netState.updates += updates.length
      for (const u of updates) {
        const idx = this.items.findIndex((it) => it.id === u.id)
        if (idx >= 0) this.items[idx] = { ...this.items[idx], ...u }
      }
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
    netState.constructed = 0
    netState.updates = 0
  })

  it('builds vis-network nodes/edges from graph data', async () => {
    mount(WikiGraph, { props: { graph: GRAPH, activePath: '' } })
    await flushPromises()
    const ids = netState.nodes.map((n) => n.id)
    expect(ids).toContain('concepts/a.md')
    expect(ids).toContain('concepts/b.md')
    expect(netState.edges).toEqual([
      { id: 'concepts/a.md→concepts/b.md', from: 'concepts/a.md', to: 'concepts/b.md' },
    ])
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

  // issue #202 问题5 回归：切换 activePath 高亮不得重建 Network 实例
  it('updates highlight via DataSet.update without rebuilding Network on activePath change', async () => {
    const wrapper = mount(WikiGraph, { props: { graph: GRAPH, activePath: 'concepts/a.md' } })
    await flushPromises()
    const constructedAfterMount = netState.constructed
    await wrapper.setProps({ activePath: 'concepts/b.md' })
    await flushPromises()
    expect(netState.constructed).toBe(constructedAfterMount) // 未 destroy + 重建
    expect(netState.updates).toBeGreaterThan(0) // 走了 DataSet.update 增量路径
    // 高亮移到 b，a 取消高亮（经活引用可见 update 生效）
    const a = netState.nodes.find((n) => n.id === 'concepts/a.md')
    const b = netState.nodes.find((n) => n.id === 'concepts/b.md')
    expect(b?.color).toBeTruthy()
    expect(a?.color).toBeFalsy()
  })

  it('rebuilds Network only when graph structure changes (issue #202)', async () => {
    const wrapper = mount(WikiGraph, { props: { graph: GRAPH, activePath: '' } })
    await flushPromises()
    const before = netState.constructed
    // 结构变化（新增节点）→ 必须重建以纳入新节点
    const grown: WikiGraphDTO = {
      nodes: [...GRAPH.nodes, { id: 'concepts/c.md', title: 'C' }],
      edges: GRAPH.edges,
    }
    await wrapper.setProps({ graph: grown })
    await flushPromises()
    expect(netState.constructed).toBe(before + 1)
    expect(netState.nodes.map((n) => n.id)).toContain('concepts/c.md')
  })
})
