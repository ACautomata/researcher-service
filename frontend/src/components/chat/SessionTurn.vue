<script setup lang="ts">
import type { TurnContent } from '@/api/sessions'
import { toolRowFromServer } from '@/chat/projection'
import MarkdownRenderer from './MarkdownRenderer.vue'
import ThinkingCard from './ThinkingCard.vue'
import ToolLine from './ToolLine.vue'
import MediaAttachment from './MediaAttachmentHost.vue'
defineProps<{ turn: TurnContent; streaming?: boolean }>()
</script>
<template>
  <ThinkingCard v-if="turn.thinking" :thinking="turn.thinking" :thinking-open="!!streaming" />
  <ToolLine v-for="tool in turn.tools" :key="tool.toolCallId" :tool="toolRowFromServer(tool)" />
  <MarkdownRenderer :text="turn.content" :streaming="!!streaming" />
  <MediaAttachment v-for="media in turn.media" :key="media.attachmentId" :media="media" />
</template>
