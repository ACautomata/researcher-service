<script setup lang="ts">
import { computed } from '@/plugins/deps'
import { parseObjectish } from '@/plugins/api'

const props = defineProps<{
  details: unknown
  input: unknown
  state: 'running' | 'done' | 'error'
  expanded: boolean
  isPartial?: boolean
  stage?: string
  toolCallId: string
  workflow?: string
}>()
const data = computed(() => parseObjectish(props.details))
const resources = computed(() => {
  const rows = data.value?.results
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row: unknown) => {
    if (!row || typeof row !== 'object') return []
    const item = row as Record<string, unknown>
    if (typeof item.title !== 'string' || typeof item.url !== 'string') return []
    try {
      const url = new URL(item.url)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return []
      const host = url.hostname.toLowerCase().replace(/^www\./, '')
      const platform = host === 'bilibili.com' || host.endsWith('.bilibili.com') ? '哔哩哔哩'
        : host === 'youtube.com' || host.endsWith('.youtube.com') ? 'YouTube'
        : host === 'zhuanlan.zhihu.com' || host === 'zhihu.com' ? '知乎'
        : host === 'blog.csdn.net' ? 'CSDN' : host
      const publisher = typeof item.publisher === 'string' ? item.publisher : null
      return [{ title: item.title, url: url.href, video: item.kind === 'video', source: publisher || platform, publisher }]
    } catch { return [] }
  })
})
</script>
<template>
  <div class="resource-card">
    <p v-if="state === 'running'">正在搜索公开学习资料和视频…</p>
    <p v-else-if="state === 'error'" role="alert">公开资源搜索失败或已取消，请稍后重试。</p>
    <template v-else>
      <p v-if="data?.partial">部分搜索来源暂不可用，结果可能不完整。</p>
      <p v-if="!resources.length">没有可展示的结果，请换个关键词重试。</p>
      <ul v-else>
        <li v-for="item in resources" :key="item.url">
          <a :href="item.url" target="_blank" rel="noopener noreferrer">{{ item.title }}</a>
          <div class="resource-meta">
            <span class="resource-type" :class="{ video: item.video }">{{ item.video ? '视频' : '资料' }}</span>
            <span class="resource-source">{{ item.source }}</span>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>
<style scoped>
.resource-card { padding: 4px 0; line-height: 1.65; }
ul { list-style: none; padding: 0; margin: 8px 0; } li { margin: 12px 0; }
a { color: var(--el-color-primary); overflow-wrap: anywhere; }
.resource-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 5px; font-size: 12px; }
.resource-type { padding: 1px 7px; border-radius: 4px; line-height: 1.6; color: var(--el-text-color-regular); background: var(--el-fill-color); }
.resource-type.video { color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.resource-source { color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
.note { color: var(--el-text-color-secondary); font-size: 12px; }
</style>
