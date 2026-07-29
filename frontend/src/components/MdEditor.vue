<script setup lang="ts">
// MdEditor —— Milkdown Typora 式实时渲染 md 编辑器（spec §9.6 / issue #45）。
// content prop 受控：打开新页（content 变化且非自回流）时 replaceAll 重载；用户编辑经
// listenerCtx.markdownUpdated 取最新 markdown 冒泡 update（供 store 防抖自动保存）。
// wikilink/frontmatter 按 commonmark/gfm 原文渲染（未接 remark 插件特殊渲染）。
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
// 自回流豁免基线（#202 问题1）：宿主受控用法（:content=draft + update 回写 draft）下，
// 用户击键 → emit → 父级写回同一 prop → watch 再触发。此时 next === lastEmitted，
// 须跳过 replaceAll——否则每次击键全文重建，ProseMirror 选区/DOM 被销毁、光标跳变。
let lastEmitted = props.content

async function build(initial: string): Promise<void> {
  if (!host.value) return
  lastEmitted = initial
  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host.value!)
      ctx.set(defaultValueCtx, initial)
      ctx.set(editorViewOptionsCtx, { editable: () => !props.readonly })
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        if (suppress) return
        lastEmitted = markdown // emit 同步记基线，watch 据此识别自回流
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

// content 变化（打开另一页）→ 编辑器内重载；自回流（next 是本组件刚 emit 的值）跳过
watch(
  () => props.content,
  (next, prev) => {
    if (!editor || next === prev || next === lastEmitted) return
    lastEmitted = next // replaceAll 后内容基线同步，避免再次被当成换页
    suppress = true
    editor.action(replaceAll(next))
    suppress = false
  },
)

// 测试/调试 seam：以 markdown 注入（模拟用户输入后的 markdownUpdated）
function _emitMarkdown(markdown: string): void {
  lastEmitted = markdown // 与真实 markdownUpdated 路径一致：emit 同步记基线
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
