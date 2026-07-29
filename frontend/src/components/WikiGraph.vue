<script setup lang="ts">
// WikiGraph —— obsidian 风格 wiki 关系图谱（spec §9.6 / issue #45 graph）。
// 节点=wiki 页（含 ghost 虚节点），边=[[wikilink]]；当前页节点高亮，点节点冒泡 open 进编辑器。
// vis-network 渲染（canvas）；数据组装与点击转发是组件 seam。
// #202 问题5：增量更新——activePath 高亮/标题变化只走 DataSet.update（保留缩放/位置与
// 物理布局），仅结构（节点集合/边集合）变化才 destroy + 重建 Network。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Network } from 'vis-network'
import { DataSet } from 'vis-data'
import type { WikiGraphDTO } from '@/api/wiki'

const props = defineProps<{ graph: WikiGraphDTO; activePath: string }>()
const emit = defineEmits<{ open: [path: string] }>()

const host = ref<HTMLDivElement | null>(null)
let network: Network | null = null
let nodesDS: DataSet<NodeItem> | null = null
let edgesDS: DataSet<EdgeItem> | null = null
// 最近一次渲染的结构指纹：比对决定是否增量更新而非重建
let lastStructureKey = ''

// 高亮当前节点的强调色（与 Element Plus primary 一致）
const ACTIVE_COLOR = '#409eff'

interface NodeItem {
  id: string
  label: string
  color?: string
  borderWidth?: number
}

interface EdgeItem {
  id: string // vis-data DataSet.update 以 id 定位条目；边无天然 id，用端点对合成
  from: string
  to: string
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

function toEdges(): EdgeItem[] {
  return props.graph.edges.map((e) => ({ id: `${e.from}→${e.to}`, from: e.from, to: e.to }))
}

// 结构指纹：节点 id 集合 + 边端点对（顺序无关）。activePath/标题变化不影响指纹。
function structureKey(): string {
  const ids = props.graph.nodes.map((n) => n.id).sort()
  const edges = props.graph.edges.map((e) => `${e.from}→${e.to}`).sort()
  return `${ids.join('\n')}|${edges.join('\n')}`
}

// 全量渲染：仅首次挂载与结构变化时调用（物理布局重算、视图状态重置的代价只在这时付）
function render(): void {
  if (!host.value) return
  network?.destroy()
  nodesDS = new DataSet(toNodes() as never)
  edgesDS = new DataSet(toEdges() as never)
  lastStructureKey = structureKey()
  network = new Network(
    host.value,
    { nodes: nodesDS as never, edges: edgesDS as never },
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
watch(
  () => [props.graph, props.activePath],
  () => {
    if (!network || !nodesDS || !edgesDS) return
    const key = structureKey()
    if (key === lastStructureKey) {
      // 结构未变（activePath 高亮/标题变化）：DataSet.update 增量改节点/边，不重建 Network
      nodesDS.update(toNodes() as never)
      edgesDS.update(toEdges() as never)
    } else {
      render()
    }
  },
  { deep: true },
)

onBeforeUnmount(() => {
  network?.destroy()
  network = null
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
