<script setup lang="ts">
import { ref } from 'vue'
import type { TurnContent } from '@/api/sessions'
import { apiFetch, parseEnvelopeBody, ApiError } from '@/api/client'
import MarkdownRenderer from './MarkdownRenderer.vue'
import ThinkingCard from './ThinkingCard.vue'
import ToolLine from './ToolLine.vue'
defineProps<{ turn: TurnContent; streaming?: boolean }>()
const error = ref('')
async function download(id: string, name: string) {
  try {
    const response = await apiFetch(`/api/v1/attachments/${encodeURIComponent(id)}/download`)
    if (response.headers.get('Content-Type')?.includes('application/json') && !response.headers.get('Content-Disposition')) {
      const envelope = await parseEnvelopeBody(response) as { code: number; message: string }
      throw new ApiError(envelope.code, envelope.message)
    }
    if (!response.ok) throw new Error('下载失败')
    const url = URL.createObjectURL(await response.blob())
    const link = document.createElement('a')
    link.href = url; link.download = name; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '下载失败' }
}
</script>
<template>
  <ThinkingCard v-if="turn.thinking" :thinking="turn.thinking" :thinking-open="!!streaming" />
  <ToolLine v-for="tool in turn.tools" :key="tool.toolCallId" :tool="{ id: tool.toolCallId, name: tool.name, state: tool.state === 'success' ? 'done' : tool.state, title: tool.name, input: tool.input, result: tool.details }" />
  <MarkdownRenderer :text="turn.content" :streaming="!!streaming" />
  <button v-for="media in turn.media" :key="media.attachmentId" type="button" @click="download(media.attachmentId, media.fileName)">下载 {{ media.fileName }}</button>
  <p v-if="error" role="alert">{{ error }}</p>
</template>
