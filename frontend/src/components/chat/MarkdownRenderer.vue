<script setup lang="ts">
// #401 / ticket #402：AI 回复 markdown 渲染组件（#340 拆分约定：props-in/emits-out 哑组件）。
// v-html 绑定 renderMarkdown(text)（渲染出口已 DOMPurify 消毒——全项目首个 v-html）；
// streaming 为真时在渲染内容尾部挂 .cursor 光标（流式边生成边渲染，markdown-it 对半成品容错为文本）。
import { computed } from 'vue'
import { renderMarkdown } from '@/chat/renderMarkdown'

const props = defineProps<{
  text: string
  streaming: boolean
}>()

const html = computed(() => renderMarkdown(props.text))
</script>

<template>
  <div class="markdown-body" v-html="html"></div>
  <span v-if="streaming" class="cursor"></span>
</template>

<style scoped>
/* #401：少量 scoped 样式贴合气泡配色（Element CSS 变量，不引 github-markdown-css 全量） */
.markdown-body {
  min-width: 0;
  max-width: 100%;
}
.markdown-body :deep(p) {
  margin: 0.4em 0;
}
.markdown-body :deep(p:first-child) {
  margin-top: 0;
}
.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}
/* 代码块：底色 + 圆角 + 内边距（贴合 assistant 气泡 var(--el-fill-color-light) 底） */
.markdown-body :deep(pre) {
  background: var(--el-fill-color-dark);
  border-radius: 8px;
  padding: 10px 12px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.5;
}
.markdown-body :deep(pre code) {
  background: transparent;
  padding: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
/* 行内代码 */
.markdown-body :deep(code) {
  background: var(--el-fill-color-dark);
  border-radius: 4px;
  padding: 1px 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em;
}
/* 链接：主题色 + 新标签页（target 由 renderMarkdown 消毒钩子强制） */
.markdown-body :deep(a) {
  color: var(--el-color-primary);
  text-decoration: none;
}
.markdown-body :deep(a:hover) {
  text-decoration: underline;
}
/* 列表缩进 */
.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  padding-left: 1.6em;
  margin: 0.4em 0;
}
/* 引用块 */
.markdown-body :deep(blockquote) {
  margin: 0.4em 0;
  padding: 2px 12px;
  border-left: 3px solid var(--el-border-color);
  color: var(--el-text-color-secondary);
}
/* 表格只在自己的 wrapper 内横向滚动，不把气泡或消息流撑宽。 */
.markdown-body :deep(.table-scroll) {
  max-width: 100%;
  margin: 0.4em 0;
  overflow-x: auto;
}
.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 0;
}
.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--el-border-color);
  padding: 4px 10px;
}
.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--el-border-color);
  margin: 0.6em 0;
}
/* 长公式只在公式区域内滚动，避免撑破消息气泡。 */
.markdown-body :deep(.katex-display) {
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
}
/* 任务列表 checkbox 不可勾选（只读展示） */
.markdown-body :deep(.task-list-item input[type='checkbox']) {
  pointer-events: none;
  margin-right: 6px;
}
/* 流式光标（assistant 由本组件负责；user 分支的 .cursor 保留在 ChatMessageItem） */
.cursor {
  display: inline-block;
  width: 7px;
  height: 14px;
  background: var(--el-color-primary);
  vertical-align: -2px;
  animation: blink 1s steps(1) infinite;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
</style>
