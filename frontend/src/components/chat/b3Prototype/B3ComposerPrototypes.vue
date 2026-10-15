<!-- B3 原型（#933）composer 换壳层——一次性原型代码，勿引为生产实现。
     对 ChatView 呈现与 ChatComposer 完全一致的 props/emits/slot 契约：
     · 非 dev 环境（生产构建 / vitest）与未带 ?variant= 时 → 原版 ChatComposer 原样直出，零行为差异；
     · ?variant=A/B/C → 渲染对应结构变体 + 底部浮动切换条（可分享、刷新稳定）；
     · 变体模式下 add-files / remove-attachment 不再上抛宿主——附件走 mock 本地预览，
       结构性保证不触真实上传端点、不写 preferredModelJson。 -->
<script setup lang="ts">
import ChatComposer from '../ChatComposer.vue'
import B3ComposerVariantA from './B3ComposerVariantA.vue'
import B3ComposerVariantB from './B3ComposerVariantB.vue'
import B3ComposerVariantC from './B3ComposerVariantC.vue'
import B3PrototypeSwitcher from './B3PrototypeSwitcher.vue'
import type { SlashOption } from '@/chat/useChatSession'
import type { PendingAttachment } from '@/chat/attachments'
import { B3_ACTIVE, b3Variant } from './b3State'

defineOptions({ name: 'B3ComposerPrototypes' })

withDefaults(
  defineProps<{
    modelValue: string
    matches: SlashOption[]
    slashOpen: boolean
    slashIndex: number
    argumentHint?: string | null
    connecting: boolean
    streaming: boolean
    disconnected: boolean
    rewindBusy?: boolean
    forkBusy?: boolean
    pendingAttachments?: PendingAttachment[]
    attachmentBusy?: boolean
    attachmentStatus?: string
  }>(),
  { pendingAttachments: () => [] },
)

const emit = defineEmits<{
  'update:modelValue': [v: string]
  input: []
  send: []
  keydown: [e: KeyboardEvent]
  pickSlash: [alias: string]
  addFiles: [files: File[]]
  removeAttachment: [key: number]
}>()
</script>

<template>
  <B3ComposerVariantA
    v-if="B3_ACTIVE && b3Variant === 'A'"
    v-bind="$props"
    @update:model-value="emit('update:modelValue', $event)"
    @input="emit('input')"
    @send="emit('send')"
    @keydown="emit('keydown', $event)"
    @pick-slash="emit('pickSlash', $event)"
  >
    <template #slash-menu="slotProps">
      <slot name="slash-menu" v-bind="slotProps" />
    </template>
  </B3ComposerVariantA>
  <B3ComposerVariantB
    v-else-if="B3_ACTIVE && b3Variant === 'B'"
    v-bind="$props"
    @update:model-value="emit('update:modelValue', $event)"
    @input="emit('input')"
    @send="emit('send')"
    @keydown="emit('keydown', $event)"
    @pick-slash="emit('pickSlash', $event)"
  >
    <template #slash-menu="slotProps">
      <slot name="slash-menu" v-bind="slotProps" />
    </template>
  </B3ComposerVariantB>
  <B3ComposerVariantC
    v-else-if="B3_ACTIVE && b3Variant === 'C'"
    v-bind="$props"
    @update:model-value="emit('update:modelValue', $event)"
    @input="emit('input')"
    @send="emit('send')"
    @keydown="emit('keydown', $event)"
    @pick-slash="emit('pickSlash', $event)"
  >
    <template #slash-menu="slotProps">
      <slot name="slash-menu" v-bind="slotProps" />
    </template>
  </B3ComposerVariantC>
  <ChatComposer
    v-else
    v-bind="$props"
    @update:model-value="emit('update:modelValue', $event)"
    @input="emit('input')"
    @send="emit('send')"
    @keydown="emit('keydown', $event)"
    @pick-slash="emit('pickSlash', $event)"
    @add-files="emit('addFiles', $event)"
    @remove-attachment="emit('removeAttachment', $event)"
  >
    <template #slash-menu="slotProps">
      <slot name="slash-menu" v-bind="slotProps" />
    </template>
  </ChatComposer>
  <B3PrototypeSwitcher v-if="B3_ACTIVE" />
</template>
