<script setup lang="ts">
// MdEditor —— Milkdown Typora 式实时渲染 md 编辑器（spec §9.6 / issue #45）。
// content prop 受控：打开新页（content 变化）时 replaceAll 重载；用户编辑经
// listenerCtx.markdownUpdated 取最新 markdown 冒泡 update（供 store 防抖自动保存）。
// wikilink/frontmatter 经 remark 插件渲染（r30 选型）。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Editor, defaultValueCtx, editorViewOptionsCtx, rootCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { replaceAll } from '@milkdown/utils'
import { nord } from '@milkdown/theme-nord'
import type { MilkdownPlugin } from '@milkdown/ctx'

// readonly：只读展示（Categories 栏目，issue #85）。ProseMirror editable=false，仍照常渲染。
const props = withDefaults(defineProps<{ content: string; readonly?: boolean }>(), {
  readonly: false,
})
const emit = defineEmits<{ update: [markdown: string] }>()

const host = ref<HTMLDivElement | null>(null)
let editor: Editor | null = null
// 受控重载期间抑制 update 冒泡（replaceAll 会触发 markdownUpdated，不能当成用户编辑回写）
let suppress = false
// 用户最近一次向父级发出的 markdown。父级把同一值写回 content 时属于受控回显，编辑器
// 已经包含该内容，不能再 replaceAll 全文重建（会丢光标并让大文档每次击键都 O(N) 重载）。
let lastEmitted: string | null = null

function emitMarkdown(markdown: string): void {
  lastEmitted = markdown
  emit('update', markdown)
}

async function build(initial: string): Promise<void> {
  if (!host.value) return
  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host.value!)
      ctx.set(defaultValueCtx, initial)
      ctx.set(editorViewOptionsCtx, { editable: () => !props.readonly })
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        if (suppress) return
        emitMarkdown(markdown)
      })
    })
    // 上游 @milkdown/theme-nord 把 nord 的 .d.ts 标为 (ctx)=>void，与 use() 要求的
    // MilkdownPlugin 契约不符（其余内置插件均正确标注）；运行时已验证，断言补齐类型。
    .use(nord as MilkdownPlugin)
    .use(commonmark)
    .use(gfm)
    .use(listener)
    .create()
}

onMounted(() => build(props.content))

// content 变化（打开另一页）→ 编辑器内重载
watch(
  () => props.content,
  (next, prev) => {
    if (!editor || next === prev) return
    if (next === lastEmitted) {
      lastEmitted = null
      return
    }
    lastEmitted = null
    suppress = true
    try {
      editor.action(replaceAll(next))
    } finally {
      suppress = false
    }
  },
)

// 测试/调试 seam：让编辑器先包含新 markdown，再按用户编辑语义发出 update。
function _emitMarkdown(markdown: string): void {
  if (!editor) return
  suppress = true
  try {
    editor.action(replaceAll(markdown))
  } finally {
    suppress = false
  }
  emitMarkdown(markdown)
}

onBeforeUnmount(() => {
  editor?.destroy()
  editor = null
})

defineExpose({ _emitMarkdown })
</script>

<template>
  <div ref="host" class="md-editor" data-test="md-editor" />
</template>

<style scoped>
.md-editor {
  height: 100%;
  overflow-y: auto;
}
</style>
