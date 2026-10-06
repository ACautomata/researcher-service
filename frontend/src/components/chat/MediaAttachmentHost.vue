<script setup lang="ts">
// 媒体读取宿主：同一引用来自消息投影或工具产物，展示组件不接触传输。
import type { MediaRef } from '@/api/sessions'
import { useAttachmentMedia } from '@/chat/useAttachmentMedia'
import MediaAttachment from './MediaAttachment.vue'
const props = withDefaults(defineProps<{ media: MediaRef; readiness?: 'pending' | 'ready' | 'error' }>(), { readiness: 'ready' })
const { url, error, loading, kind, load, download } = useAttachmentMedia(props)
</script>
<template>
  <MediaAttachment :media="media" :readiness="readiness" :url="url" :error="error" :loading="loading" :kind="kind"
    @load="load" @download="download" @preview-error="error = '图片预览失败，可下载查看'" />
</template>
