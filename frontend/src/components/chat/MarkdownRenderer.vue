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
.markdown-body :deep(p) {
  margin: 0.4em 0;
}
.markdown-body :deep(p:first-child) {
  margin-top: 0;
}
.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}
/* 覆盖全局落地页 h1/h2 大字号，避免聊天/Wiki Markdown 标题行高与正文重叠。 */
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  font-family: inherit;
  color: var(--el-text-color-primary);
  line-height: 1.35;
  letter-spacing: 0;
}
.markdown-body :deep(h1) {
  margin: 0.2em 0 0.7em;
  font-size: 1.65em;
  font-weight: 650;
}
.markdown-body :deep(h2) {
  margin: 1.15em 0 0.5em;
  font-size: 1.3em;
  font-weight: 650;
}
.markdown-body :deep(h3) {
  margin: 1em 0 0.42em;
  font-size: 1.08em;
  font-weight: 650;
}
.markdown-body :deep(h4) {
  margin: 0.85em 0 0.35em;
  font-size: 1em;
  font-weight: 650;
}
/* 代码块：底色 + 圆角 + 内边距（贴合 assistant 气泡 var(--el-fill-color-light) 底） */
.markdown-body :deep(pre) {
  background: var(--el-fill-color-dark);
  color: var(--el-text-color-primary);
  border-radius: 8px;
  padding: 10px 12px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.5;
}
.markdown-body :deep(pre code) {
  display: block;
  background: transparent;
  padding: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
/* 行内代码 */
.markdown-body :deep(code) {
  display: inline;
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
/* 表格边框 */
.markdown-body :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.4em 0;
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
.markdown-body :deep(.katex-display) {
  margin: 0.9em 0;
  padding: 0.7em 0.9em;
  overflow-x: auto;
  overflow-y: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 7px;
  background: var(--el-fill-color-lighter);
  text-align: center;
}
.markdown-body :deep(.katex) {
  color: var(--el-text-color-primary);
  font-size: 1.02em;
  line-height: 1.35;
}
/* 任务列表 checkbox 不可勾选（只读展示） */
.markdown-body :deep(.task-list-item input[type='checkbox']) {
  pointer-events: none;
  margin-right: 6px;
}
@media (prefers-color-scheme: dark) {
  .markdown-body :deep(pre),
  .markdown-body :deep(code) {
    background: #11141a;
    color: #d8dee9;
  }
  .markdown-body :deep(pre code) {
    background: transparent;
  }
  .markdown-body :deep(th) {
    background: #23262f;
  }
  .markdown-body :deep(th),
  .markdown-body :deep(td) {
    border-color: #3b404b;
  }
  .markdown-body :deep(blockquote) {
    border-left-color: #566171;
    color: #aeb6c2;
  }
  .markdown-body :deep(.hljs-keyword),
  .markdown-body :deep(.hljs-selector-tag),
  .markdown-body :deep(.hljs-literal) { color: #c792ea; }
  .markdown-body :deep(.hljs-string),
  .markdown-body :deep(.hljs-title),
  .markdown-body :deep(.hljs-section) { color: #a7d98b; }
  .markdown-body :deep(.hljs-number),
  .markdown-body :deep(.hljs-symbol) { color: #f2b36d; }
  .markdown-body :deep(.hljs-comment),
  .markdown-body :deep(.hljs-quote) { color: #7f8b99; }
  .markdown-body :deep(.hljs-built_in),
  .markdown-body :deep(.hljs-type) { color: #82c7e5; }
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
