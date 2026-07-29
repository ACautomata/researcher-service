<script setup lang="ts">
// WikiGraph —— obsidian 风格 wiki 关系图谱（spec §9.6 / issue #45 graph）。
// 节点=wiki 页（含 ghost 虚节点），边=[[wikilink]]；当前页节点高亮，点节点冒泡 open 进编辑器。
// vis-network 渲染（canvas）；数据组装与点击转发是组件 seam。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Network } from 'vis-network'
import { DataSet } from 'vis-data'
import type { WikiGraphDTO } from '@/api/wiki'

const props = defineProps<{ graph: WikiGraphDTO; activePath: string }>()
const emit = defineEmits<{ open: [path: string] }>()

const host = ref<HTMLDivElement | null>(null)
let network: Network | null = null
// 持有 DataSet 引用：activePath 高亮变化时增量 update，不销毁重建 Network（issue #202 问题5）
let nodesData: DataSet<NodeItem> | null = null

// 高亮当前节点的强调色（与 Element Plus primary 一致）
const ACTIVE_COLOR = '#409eff'

interface NodeItem {
  id: string
  label: string
  color?: string
  borderWidth?: number
}

function toNodes(): NodeItem[] {
  return props.graph.nodes.map((n) => ({
    id: n.id,
    label: n.title,
    // 当前页高亮描边；ghost 虚节点淡色
    color: n.id === props.activePath ? ACTIVE_COLOR : undefined,
    borderWidth: n.id === props.activePath ? 3 : 1,
  }))
}

function toEdges(): Array<{ from: string; to: string }> {
  return props.graph.edges.map((e) => ({ from: e.from, to: e.to }))
}

function render(): void {
  if (!host.value) return
  network?.destroy()
  nodesData = new DataSet<NodeItem>(toNodes())
  network = new Network(
    host.value,
    { nodes: nodesData as never, edges: new DataSet(toEdges() as never) },
    {
      nodes: { shape: 'dot', size: 12, font: { size: 12 } },
      edges: { arrows: 'to', color: '#c0c4cc' },
      physics: { barnesHut: { gravitationalConstant: -8000 } },
    },
  )
  network.on('click', (params: { nodes: string[] }) => {
    const id = params.nodes[0]
    if (id) emit('open', id)
  })
}

onMounted(render)

// 结构变化（图谱数据本身变了）才整图重建
watch(() => props.graph, render, { deep: true })

// activePath 高亮变化仅增量更新受影响节点的描边/配色：
// 重建 Network 会重跑 barnesHut 物理布局且丢失缩放/位移视图状态（issue #202 问题5）
watch(
  () => props.activePath,
  (next, prev) => {
    if (!nodesData) return
    const updates: NodeItem[] = []
    for (const id of [prev, next]) {
      if (!id) continue
      const node = props.graph.nodes.find((n) => n.id === id)
      if (!node) continue // 节点不在当前图谱（如换容器途中）→ 由 graph watch 重建兜底
      updates.push({
        id: node.id,
        label: node.title,
        color: id === next ? ACTIVE_COLOR : undefined,
        borderWidth: id === next ? 3 : 1,
      })
    }
    if (updates.length) nodesData.update(updates as never)
  },
)

onBeforeUnmount(() => {
  network?.destroy()
  network = null
  nodesData = null
})
</script>

<template>
  <div ref="host" class="wiki-graph" data-test="wiki-graph" />
</template>

<style scoped>
.wiki-graph {
  height: 100%;
  min-height: 300px;
}
</style>
