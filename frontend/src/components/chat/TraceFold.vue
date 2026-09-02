<script setup lang="ts">
// T1 轮次折叠条（#664 / CONTEXT.md「折叠条」）：轮次正常完成后轨迹（思考+工具）收进的单个折叠块
// 的条面。props-in/emits-out 哑组件（贴现有 chat 展示组件形态）：条面显示计数文案（T1 无时长版
// ——执行时长计时为后续票），点击 emit('toggle') 回父层落 store；折叠态由 store 驱动（folded prop
// 只作条面箭头方向指示），轨迹条目（思考卡/工具行）由父层在折叠条外按展开态渲染。
import { computed } from 'vue'

const props = defineProps<{
  hasThinking: boolean // 本轮含思考
  toolCount: number // 本轮工具调用行数
  folded: boolean // 当前折叠态（条面在折叠/展开两态都渲染，箭头指示当前态）
}>()

const emit = defineEmits<{ toggle: [] }>()

// 条面计数文案（无时长版）：思考段/工具段按实际内容有无拼接，纯思考/纯工具轮按实际内容计数。
// 「执行过程 · 思考 · 5 次工具」/「执行过程 · 思考」/「执行过程 · 3 次工具」。
const label = computed(() => {
  const parts = ['执行过程']
  if (props.hasThinking) parts.push('思考')
  if (props.toolCount > 0) parts.push(`${props.toolCount} 次工具`)
  return parts.join(' · ')
})
</script>

<template>
  <button type="button" class="trace-fold" data-test="trace-fold" @click="emit('toggle')">
    <span class="caret" :class="{ open: !folded }">▶</span>
    <span class="label" data-test="trace-fold-label">{{ label }}</span>
  </button>
</template>

<style scoped>
.trace-fold {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 6px 12px;
  border: 1px dashed var(--el-border-color);
  border-radius: 10px;
  background: var(--el-fill-color-light);
  color: var(--el-color-primary);
  font-size: 12.5px;
  cursor: pointer;
  user-select: none;
  text-align: left;
}
.trace-fold .caret { display: inline-block; font-size: 10px; transition: transform .18s; }
.trace-fold .caret.open { transform: rotate(90deg); }
.trace-fold .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
