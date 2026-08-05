<script setup lang="ts">
// T08 思考链折叠卡（spec §8.3 (a) / r26 §4）：思考以 <thinking> 标签内联在 text 增量里，
// 前端内容层剥离后独立渲染真实思考；流式中（thinkingOpen）标注「思考中…」。
defineProps<{
  thinking: string
  thinkingOpen: boolean
}>()
</script>

<template>
  <details class="cot" data-test="cot-card">
    <summary class="cot-head">
      <span class="caret">▶</span> 思考过程
      <span v-if="thinkingOpen" class="cot-flag thinking">思考中…</span>
    </summary>
    <div class="cot-body">{{ thinking }}</div>
  </details>
</template>

<style scoped>
.cot { border: 1px dashed var(--el-border-color); background: var(--el-fill-color-light); border-radius: 10px; margin-bottom: 8px; }
.cot-head { display: flex; align-items: center; gap: 8px; padding: 6px 12px; cursor: pointer; font-size: 12.5px; color: var(--el-color-primary); user-select: none; list-style: none; }
.cot-head::-webkit-details-marker { display: none; }
.cot .caret { display: inline-block; transition: transform .18s; }
.cot[open] .cot-head .caret { transform: rotate(90deg); }
.cot-flag { margin-left: auto; font-size: 10.5px; border-radius: 6px; padding: 1px 6px; }
.cot-flag.thinking { color: var(--el-color-primary); border: 1px dashed var(--el-color-primary); }
.cot-body { padding: 0 12px 8px; color: var(--el-text-color-secondary); font-size: 12.5px; white-space: pre-wrap; }
</style>
