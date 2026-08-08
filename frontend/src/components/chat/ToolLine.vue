<script setup lang="ts">
// T08 工具执行（spec §9.4 / 原型 oc-chat-page）：一行一个——图标+工具标题/名(mono)+关键参数+状态，
// 不展开输入输出细节。props-in/emits-out 哑组件（#316：#340 拆分边界）。
import type { ToolRow } from '@/stores/chat'

defineProps<{
  tool: ToolRow
}>()

// T08 工具行关键参数摘要（spec §9.4）：把网关透传的 input（dict/str）压成一行短串，不逐字段展开细节。
// 字段名待配对后实测校准（见后端 event_translate._translate_tool）；MVP 取前两个键值对，避免占满气泡。
function formatToolInput(input: unknown): string {
  if (input == null || input === '') return ''
  if (typeof input === 'string') return input
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>
    return Object.keys(obj)
      .slice(0, 2)
      .map((k) => `${k}=${typeof obj[k] === 'string' ? obj[k] : JSON.stringify(obj[k])}`)
      .join(' ')
  }
  return String(input)
}
</script>

<template>
  <div class="tool" :class="tool.state" data-test="tool-line">
    <span class="t-icon">🔧</span>
    <span class="t-name" :title="typeof tool.title === 'string' ? tool.title : ''">{{ typeof tool.title === 'string' ? tool.title : tool.name }}</span>
    <span v-if="formatToolInput(tool.input)" class="t-args" :title="formatToolInput(tool.input)">{{ formatToolInput(tool.input) }}</span>
    <span class="t-state">{{ tool.state === 'running' ? '⟳ 运行中' : tool.state === 'error' ? '✗ 失败' : '✓ 完成' }}</span>
  </div>
</template>

<style scoped>
.tool { display: flex; align-items: center; min-width: 0; gap: 9px; background: var(--el-fill-color); border: 1px solid var(--el-border-color); border-radius: 9px; padding: 6px 12px; margin: 4px 0; font-size: 12.5px; }
.tool .t-icon { color: var(--el-color-primary); }
.tool .t-name { font-family: ui-monospace, monospace; }
.tool .t-args { min-width: 0; overflow: hidden; color: var(--el-text-color-secondary); text-overflow: ellipsis; white-space: nowrap; }
.tool .t-state { flex: none; margin-left: auto; display: flex; align-items: center; gap: 5px; }
.tool.running .t-state { color: var(--el-color-warning); }
.tool.error .t-state { color: var(--el-color-danger); }
.tool.done .t-state { color: var(--el-color-success); }
</style>
