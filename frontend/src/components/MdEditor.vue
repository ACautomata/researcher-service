<script setup lang="ts">
// MdEditor —— Milkdown Typora 式实时渲染 md 编辑器（spec §9.6 / issue #45）。
// content prop 受控：打开新页（content 变化）时 replaceAll 重载；用户编辑经
// listenerCtx.markdownUpdated 取最新 markdown 冒泡 update（供 store 防抖自动保存）。
// wikilink/frontmatter 经 remark 插件渲染（r30 选型）。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Editor, defaultValueCtx, rootCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { replaceAll } from '@milkdown/utils'
import { nord } from '@milkdown/theme-nord'
import type { MilkdownPlugin } from '@milkdown/ctx'

const props = defineProps<{ content: string }>()
const emit = defineEmits<{ update: [markdown: string] }>()

const host = ref<HTMLDivElement | null>(null)
let editor: Editor | null = null
// 受控重载期间抑制 update 冒泡（replaceAll 会触发 markdownUpdated，不能当成用户编辑回写）
let suppress = false

async function build(initial: string): Promise<void> {
  if (!host.value) return
  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host.value!)
      ctx.set(defaultValueCtx, initial)
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        if (suppress) return
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

// content 变化（打开另一页）→ 编辑器内重载
watch(
  () => props.content,
  (next, prev) => {
    if (!editor || next === prev) return
    suppress = true
    editor.action(replaceAll(next))
    suppress = false
  },
)

// 测试/调试 seam：以 markdown 注入（模拟用户输入后的 markdownUpdated）
function _emitMarkdown(markdown: string): void {
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
