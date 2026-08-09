<script setup lang="ts">
// #401 / ticket #402：AI 回复 markdown 渲染组件（#340 拆分约定：props-in/emits-out 哑组件）。
// v-html 绑定 renderMarkdown(text)（渲染出口已 DOMPurify 消毒——全项目首个 v-html）；
// streaming 为真时把 .cursor 插入最后一段实际内容，避免块级 Markdown 让光标脱离回答末尾。
import { computed } from 'vue'
import { renderMarkdown } from '@/chat/renderMarkdown'

const props = defineProps<{
  text: string
  streaming: boolean
}>()

const blockTags = new Set(['P', 'LI', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'DIV'])

function appendStreamingCursor(rendered: string): string {
  const template = document.createElement('template')
  template.innerHTML = rendered

  const cursor = document.createElement('span')
  cursor.className = 'cursor'

  // 跳过 markdown-it 在块元素间生成的换行，只选最后一个含可见内容的文本节点。
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
  let lastText: Text | null = null
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (node.data.trim()) lastText = node
  }

  if (!lastText?.parentNode) {
    template.content.append(cursor)
    return template.innerHTML
  }

  // 跳出链接、强调等内联元素，但停留在最后一个段落/列表项/单元格/代码块内部。
  let insertionPoint: Node = lastText
  while (insertionPoint.parentElement && !blockTags.has(insertionPoint.parentElement.tagName)) {
    insertionPoint = insertionPoint.parentElement
  }
  insertionPoint.parentNode?.insertBefore(cursor, insertionPoint.nextSibling)
  return template.innerHTML
}

const html = computed(() => {
  const rendered = renderMarkdown(props.text)
  return props.streaming ? appendStreamingCursor(rendered) : rendered
})

async function onClick(event: MouseEvent): Promise<void> {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-copy-code]')
  if (!button) return
  const code = button.parentElement?.querySelector('code')?.textContent ?? ''
  await navigator.clipboard.writeText(code)
  button.textContent = '已复制'
}
</script>

<template>
  <div class="markdown-body" v-html="html" @click="onClick"></div>
</template>

<style scoped>
/* #401：少量 scoped 样式贴合气泡配色（Element CSS 变量，不引 github-markdown-css 全量） */
.markdown-body {
  min-width: 0;
  max-width: 100%;
}
.markdown-body :deep(.code-wrap) { position: relative; }
.markdown-body :deep(.copy-code) { position: absolute; top: 6px; right: 6px; z-index: 1; border: 1px solid var(--el-border-color); border-radius: 5px; background: var(--el-bg-color-overlay); color: var(--el-text-color-secondary); cursor: pointer; }
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  margin: 0.8em 0 0.4em;
  color: inherit;
  font-weight: 650;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.markdown-body :deep(h1:first-child),
.markdown-body :deep(h2:first-child),
.markdown-body :deep(h3:first-child),
.markdown-body :deep(h4:first-child) {
  margin-top: 0;
}
.markdown-body :deep(h1) { font-size: 1.5em; }
.markdown-body :deep(h2) { font-size: 1.3em; }
.markdown-body :deep(h3) { font-size: 1.15em; }
.markdown-body :deep(h4) { font-size: 1em; }
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
.markdown-body :deep(.cursor) {
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
