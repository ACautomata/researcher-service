<script setup lang="ts">
// 输入区 + 斜杠命令补全（#316：#340 拆分边界，props-in/emits-out 哑组件）。
// 斜杠菜单（slash-menu slot）由父注入表现；输入/键盘事件上抛。
// 匹配计算（slashQuery/slashMatches/slashOpen）单一来源在 ChatView（逻辑留宿主）——
// 本组件只收 matches/slashOpen props 渲染菜单，不重复计算。
import type { SlashOption } from '@/chat/useChatConnection'

const props = defineProps<{
  modelValue: string
  matches: SlashOption[]
  slashOpen: boolean
  slashIndex: number
  connecting: boolean
  streaming: boolean
  disconnected: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: string]
  input: []
  send: []
  keydown: [e: KeyboardEvent]
  pickSlash: [alias: string]
}>()

defineSlots<{
  'slash-menu'?: (props: { matches: SlashOption[]; slashIndex: number }) => unknown
}>()

// 真实用户输入（非程序化赋值）：上抛 update:modelValue（v-model）+ input（父复位菜单态）
function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value)
  emit('input')
}
</script>

<template>
  <div class="composer">
    <!-- T07 斜杠命令补全（spec §9.4 / 原型 oc-chat-page.html）：输入 `/` 弹菜单（前缀过滤，
         cmd mono + 描述），点选/↑↓+Enter 选中填入后经普通 send() 发 `/cmd`。 -->
    <slot
      v-if="slashOpen"
      name="slash-menu"
      :matches="matches"
      :slash-index="slashIndex"
    />
    <textarea
      :value="modelValue"
      data-test="input"
      rows="2"
      placeholder="发消息…（Enter 发送 / Shift+Enter 换行；输 / 弹命令补全）"
      @input="onInput"
      @keydown="emit('keydown', $event)"
    ></textarea>
    <button
      data-test="send"
      :disabled="connecting || streaming || disconnected"
      @click="emit('send')"
    >发送</button>
  </div>
</template>

<style scoped>
.composer { position: relative; display: flex; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--el-border-color); }
.composer textarea { flex: 1; resize: none; padding: 8px; border: 1px solid var(--el-border-color); border-radius: 8px; }
.composer button { padding: 8px 16px; background: var(--el-color-primary); color: #fff; border: none; border-radius: 8px; cursor: pointer; }
</style>
