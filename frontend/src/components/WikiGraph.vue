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

interface NodeItem {
  id: string
  label: string
  color?: string
  borderWidth?: number
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

function toNodes(): NodeItem[] {
  const activeColor = cssVar('--el-color-primary', '#409eff')
  return props.graph.nodes.map((n) => ({
    id: n.id,
    label: n.title,
    // 当前页高亮描边；ghost 虚节点淡色
    color: n.id === props.activePath ? activeColor : undefined,
    borderWidth: n.id === props.activePath ? 3 : 1,
  }))
}

function toEdges(): Array<{ from: string; to: string }> {
  return props.graph.edges.map((e) => ({ from: e.from, to: e.to }))
}

function render(): void {
  if (!host.value) return
  const textColor = cssVar('--el-text-color-regular', '#606266')
  const borderColor = cssVar('--el-border-color', '#c0c4cc')
  network?.destroy()
  network = new Network(
    host.value,
    { nodes: new DataSet(toNodes() as never), edges: new DataSet(toEdges() as never) },
    {
      nodes: { shape: 'dot', size: 12, font: { size: 12, color: textColor } },
      edges: { arrows: 'to', color: borderColor },
      physics: { barnesHut: { gravitationalConstant: -8000 } },
    },
  )
  network.on('click', (params: { nodes: string[] }) => {
    const id = params.nodes[0]
    if (id) emit('open', id)
  })
}

onMounted(render)
watch(() => [props.graph, props.activePath], render, { deep: true })

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
