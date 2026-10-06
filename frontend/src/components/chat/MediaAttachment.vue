<script setup lang="ts">
// 纯展示：媒体状态由读取宿主注入，用户操作上抛。
import type { MediaRef } from '@/api/sessions'
withDefaults(defineProps<{
  media: MediaRef
  readiness?: 'pending' | 'ready' | 'error'
  url?: string
  error?: string
  loading?: boolean
  kind?: 'image' | 'audio' | 'video' | 'file'
}>(), { readiness: 'ready', url: '', error: '', loading: false, kind: 'file' })
const emit = defineEmits<{ download: []; load: []; previewError: [] }>()
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
</script>
<template>
  <div class="media-file" data-test="media-file">
    <div class="media-caption">
      <span class="media-name" :title="media.fileName">{{ media.fileName || '附件' }}</span>
      <span class="media-meta">
        <span v-if="media.width && media.height">{{ media.width }} × {{ media.height }}</span>
        <span v-if="media.durationMs != null">{{ formatDuration(media.durationMs) }}</span>
        <span>{{ formatBytes(media.size) }}</span>
      </span>
      <button type="button" data-test="media-download" :disabled="loading || readiness !== 'ready'" @click="emit('download')">下载</button>
    </div>
    <p v-if="readiness === 'pending'" role="status">附件正在就位…</p>
    <p v-else-if="readiness === 'error'" role="alert">附件就位失败，请重新发送</p>
    <template v-else>
      <p class="ready" data-test="media-ready">已就位</p>
      <p v-if="loading" role="status">正在加载附件…</p>
      <div v-if="error" role="alert">{{ error }} <button type="button" @click="emit('load')">重试</button></div>
      <img v-if="url && kind === 'image'" :src="url" :alt="media.fileName" class="media-image" @error="emit('previewError')" />
      <audio v-else-if="url && kind === 'audio'" :src="url" controls preload="metadata" :aria-label="media.fileName" />
      <video v-else-if="url && kind === 'video'" :src="url" controls preload="metadata" :aria-label="media.fileName" />
    </template>
  </div>
</template>
<style scoped>
.media-file { min-width: 0; max-width: 100%; padding: 10px 12px; border: 1px solid var(--el-border-color); border-radius: 10px; background: var(--el-fill-color-light); font-size: 13px; white-space: normal; }
.media-caption { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.media-name { min-width: 0; overflow-wrap: anywhere; flex: 1; }
.media-meta { display: flex; flex-wrap: wrap; gap: 8px; color: var(--el-text-color-secondary); font-size: 12px; }
button { border: 0; background: transparent; color: var(--el-color-primary); cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
.media-image, video { display: block; max-width: 100%; max-height: 480px; margin-top: 8px; border-radius: 6px; object-fit: contain; }
audio { display: block; max-width: 100%; margin-top: 8px; }
p { margin: 8px 0 0; color: var(--el-text-color-secondary); }
[role="alert"] { color: var(--el-color-danger); }
</style>
