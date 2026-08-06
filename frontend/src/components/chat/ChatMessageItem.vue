<script setup lang="ts">
// 单条聊天消息（#316：#340 拆分边界，props-in/emits-out 哑组件）。
// thinking/tool-line slot 注入点：默认渲染 ThinkingCard/ToolLine；父可经 slot 覆盖表现。
// #401 / ticket #402：assistant 正文走 MarkdownRenderer（v-html + DOMPurify 消毒），
// user 保持纯文本（用户输入的 * # _ 不当语法）；流式光标由 MarkdownRenderer streaming 控制。
import type { Msg } from '@/stores/chat'
import ThinkingCard from '@/components/chat/ThinkingCard.vue'
import ToolLine from '@/components/chat/ToolLine.vue'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'

defineProps<{
  msg: Msg
}>()

defineSlots<{
  thinking?: (props: { thinking: string; thinkingOpen: boolean }) => unknown
  'tool-line'?: (props: { tool: Msg['tools'][number] }) => unknown
}>()
</script>

<template>
  <div class="msg" :class="msg.role">
    <div class="bubble">
      <!-- T08 思考链折叠卡（spec §8.3 (a) / r26 §4） -->
      <slot name="thinking" :thinking="msg.thinking" :thinking-open="msg.thinkingOpen">
        <ThinkingCard v-if="msg.role === 'assistant' && msg.thinking" :thinking="msg.thinking" :thinking-open="msg.thinkingOpen" />
      </slot>
      <!-- T08 工具执行（spec §9.4 / 原型 oc-chat-page） -->
      <template v-for="(t, ti) in msg.tools" :key="`tool-${ti}`">
        <slot name="tool-line" :tool="t">
          <ToolLine :tool="t" />
        </slot>
      </template>
      <!-- #401：assistant 渲染 markdown（含流式光标），user 保持纯文本 + 光标 -->
      <MarkdownRenderer v-if="msg.role === 'assistant'" :text="msg.text" :streaming="msg.streaming" />
      <template v-else>{{ msg.text }}<span v-if="msg.streaming" class="cursor"></span></template>
      <div v-if="msg.role === 'assistant' && !msg.streaming" class="ai-notice" data-test="ai-notice">
        内容由 AI 生成，仅供参考
      </div>
    </div>
  </div>
</template>

<style scoped>
.msg { display: flex; max-width: 840px; }
.msg.user { align-self: flex-end; }
.bubble { padding: 10px 14px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
.msg.assistant .bubble { background: var(--el-fill-color-light); }
.msg.user .bubble { background: var(--el-color-primary-light-8); }
.ai-notice {
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px solid var(--el-border-color-lighter);
  color: var(--el-text-color-placeholder);
  font-size: 12px;
  line-height: 1.4;
}
.cursor { display: inline-block; width: 7px; height: 14px; background: var(--el-color-primary); vertical-align: -2px; animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
</style>
