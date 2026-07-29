<script setup lang="ts">
// MdEditor —— Milkdown Typora 式实时渲染 md 编辑器（spec §9.6 / issue #45）。
// content prop 受控：打开新页（content 变化且非自回流）时 replaceAll 重载；用户编辑经
// listenerCtx.markdownUpdated 取最新 markdown 冒泡 update（供 store 防抖自动保存）。
// wikilink/frontmatter 不做特殊渲染：仅按 commonmark/gfm 原文展示（未接 remark 插件）。
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
// 自回流豁免（issue #202 问题1）：emit 时同步记下 markdown，父级受控回写同一值时
// watch 直接跳过——否则每次击键都 replaceAll 全文重建，选区/DOM 锚点被销毁（光标跳变）。
let lastEmitted = ''

async function build(initial: string): Promise<void> {
  if (!host.value) return
  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host.value!)
      ctx.set(defaultValueCtx, initial)
      ctx.set(editorViewOptionsCtx, { editable: () => !props.readonly })
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        if (suppress) return
        lastEmitted = markdown
        emit('update', markdown)
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

// content 变化（打开另一页）→ 编辑器内重载；自回流（父级把我们刚 emit 的值写回）跳过
watch(
  () => props.content,
  (next, prev) => {
    if (!editor || next === prev) return
    if (next === lastEmitted) return // 自回流：编辑器内已是该内容，无需 replaceAll
    suppress = true
    editor.action(replaceAll(next))
    suppress = false
    lastEmitted = next
  },
)

// 测试/调试 seam：以 markdown 注入（模拟用户输入后的 markdownUpdated）
function _emitMarkdown(markdown: string): void {
  lastEmitted = markdown
  emit('update', markdown)
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
