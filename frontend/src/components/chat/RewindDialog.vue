<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import type { RewindPreview, RewindScope } from '@/api/sessions'
defineProps<{ preview: RewindPreview; busy: boolean }>()
const emit = defineEmits<{ confirm: [scope: RewindScope]; cancel: [] }>()
const scope = ref<RewindScope>('all')
const dialog = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialog.value?.querySelector<HTMLSelectElement>('select')?.focus()
})
onBeforeUnmount(() => previousFocus?.focus())
function trapFocus(e: KeyboardEvent): void {
  if (e.key !== 'Tab') return
  const nodes = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)') ?? [])
  const first = nodes[0], last = nodes[nodes.length - 1]
  if (!first || !last) { e.preventDefault(); return }
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
}
</script>

<template>
  <Teleport to="body">
    <div class="restore-backdrop" @keydown.esc="!busy && emit('cancel')">
      <section ref="dialog" class="restore-dialog" @keydown="trapFocus" role="dialog" aria-modal="true" aria-labelledby="restore-title">
        <h2 id="restore-title">恢复到所选消息锚点</h2>
        <p>回退对话会归档后续路线，无法切回。需要保留路线时，请先分叉。</p>
        <label>恢复范围 <select v-model="scope" :disabled="busy" autofocus>
          <option value="all">两者同回</option>
          <option value="chat">只回对话</option>
          <option value="files">只回文件</option>
        </select></label>
        <p>{{ preview.revertOps }} 次文件操作，涉及 {{ preview.pathTotal }} 个路径。</p>
        <ul><li v-for="path in preview.pathSample" :key="path"><code>{{ path }}</code></li></ul>
        <p v-if="preview.pathTotal > preview.pathSample.length">这里只列出部分路径。</p>
        <p v-if="scope === 'chat'">文件保持现状；这些文件操作此后不再参与回退。</p>
        <p v-else>若超过服务端恢复深度上限，文件会保持现状，完成后会明确提示降级结果。</p>
        <p>以下 exec 的副作用不会回退（包括未记录的文件更改）：</p>
        <ul data-test="exec-crossed"><li v-for="(exec, i) in preview.execCrossed" :key="`${exec.toolCallId}-${i}`"><code>{{ exec.input }}</code></li></ul>
        <p v-if="!preview.execCrossed.length">未跨越 exec 调用。</p>
        <footer>
          <button type="button" :disabled="busy" @click="emit('cancel')">取消</button>
          <button type="button" :disabled="busy" data-test="restore-confirm" @click="emit('confirm', scope)">{{ busy ? '恢复中…' : '确认恢复' }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.restore-backdrop { position: fixed; inset: 0; z-index: 2200; background: #0006; display: grid; place-items: center; padding: 16px; }
.restore-dialog { box-sizing: border-box; width: min(560px, 100%); max-height: 85vh; overflow: auto; border-radius: 12px; padding: 20px; background: var(--el-bg-color-overlay); color: var(--el-text-color-primary); box-shadow: 0 12px 40px #0004; font-size: 14px; }
h2 { margin: 0 0 12px; font-size: 18px; }
code { white-space: pre-wrap; overflow-wrap: anywhere; }
footer { display: flex; justify-content: flex-end; gap: 12px; }
button, select { padding: 6px 12px; color: inherit; background: var(--el-fill-color); border: 1px solid var(--el-border-color); border-radius: 6px; }
button:disabled { opacity: .5; }
</style>
