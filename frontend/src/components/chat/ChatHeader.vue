<script setup lang="ts">
// 顶部栏：会话标题 + 容器 tag + 连接态（#316：#340 拆分边界，props-in/emits-out 哑组件）。
defineProps<{
  title: string
  container: string
  connecting: boolean
}>()

defineSlots<{
  banner?: (props: {}) => unknown
}>()
</script>

<template>
  <div class="topbar">
    <span class="title" data-test="chat-title" :title="title || '对话'">{{ title || '对话' }}</span>
    <span v-if="container" class="tag">{{ container }}</span>
    <span v-if="connecting" class="tag warn">连接中…</span>
    <slot name="banner" />
  </div>
</template>

<style scoped>
.topbar { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 10px 18px; border-bottom: 1px solid var(--el-border-color); }
.title { flex: 1; min-width: 0; overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.tag { flex: 0 0 auto; white-space: nowrap; font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--el-fill-color-light); color: var(--el-text-color-secondary); }
.tag.warn { color: var(--el-color-warning); }
</style>
