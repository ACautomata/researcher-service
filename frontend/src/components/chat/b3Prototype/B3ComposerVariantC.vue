<!-- B3 原型（#933）变体 C「全内嵌舱」——一次性原型代码，勿引为生产实现。
     结构主张：composer 收敛为单个自洽舱体——框外零控件：📎 舱内最左、推理强度是
     舱内三段式拖拽段控件（拖过即换档，段即刻度）、模型 chip 与圆形发送键同排舱内；
     上拉菜单自舱内 chip 弹出（紧凑单行形态）。控制密度最高，全部操作不离输入框。
     mock 只读：附件本地预览不触上传端点，模型/强度只写内存态不落 preferredModelJson。 -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { SlashOption } from '@/chat/useChatSession'
import { B3_EFFORT_STOPS, B3_MODEL_OPTIONS, type B3EffortValue } from './b3Presets'
import {
  b3ActiveOption,
  b3AddMockAttachments,
  b3Effort,
  b3MockAttachments,
  b3RemoveMockAttachment,
  b3SelectedModel,
} from './b3State'

defineOptions({ name: 'B3ComposerVariantC' })

const props = withDefaults(
  defineProps<{
    modelValue: string
    matches: SlashOption[]
    slashOpen: boolean
    slashIndex: number
    argumentHint?: string | null
    connecting: boolean
    streaming: boolean
    disconnected: boolean
    rewindBusy?: boolean
    forkBusy?: boolean
    pendingAttachments?: unknown[]
    attachmentBusy?: boolean
    attachmentStatus?: string
  }>(),
  { pendingAttachments: () => [] },
)

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

function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value)
  emit('input')
}

const inputEl = ref<HTMLTextAreaElement | null>(null)
function resize(): void {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`
}
watch(() => props.modelValue, () => void nextTick(resize), { immediate: true })

// ---- 附件（mock 采集：本地预览，不触真实上传）----
const fileInput = ref<HTMLInputElement | null>(null)
function openFilePicker(): void {
  fileInput.value?.click()
}
function collect(files: File[]): void {
  const error = b3AddMockAttachments(files)
  if (error) ElMessage.error(error)
}
function onPick(e: Event): void {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (files.length) collect(files)
  input.value = ''
}
function onPaste(e: ClipboardEvent): void {
  const files = Array.from(e.clipboardData?.files ?? [])
  if (files.length) {
    e.preventDefault()
    collect(files)
  }
}
function onDrop(e: DragEvent): void {
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (!files.length) return
  e.preventDefault()
  collect(files)
}

// ---- 模型上拉菜单（舱内 chip 向上弹出；紧凑单行）----
const menuOpen = ref(false)
const chipLabel = computed(() => (b3SelectedModel.value ? b3ActiveOption.value.name : '默认'))
function pickModel(providerId: string, modelId: string): void {
  b3SelectedModel.value = providerId ? { providerId, modelId } : null
  menuOpen.value = false
}

// ---- 推理强度（三段式拖拽段控件；能力映射照 B2 决议）----
const cap = computed(() => b3ActiveOption.value.capability)
const effortEnabled = computed(() => cap.value !== 'none')
const capNote = computed(() => b3ActiveOption.value.effortNote)
const effLabel = computed(() => B3_EFFORT_STOPS[b3Effort.value].label)
const segsEl = ref<HTMLElement | null>(null)
const dragging = ref(false)
// 段控件按三等分换档（段即刻度），与 A/B 的连续轨 + 吸附手感形成形态对照。
function stopFromClientX(clientX: number): B3EffortValue {
  const el = segsEl.value
  if (!el) return b3Effort.value
  const rect = el.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  return Math.min(2, Math.floor(ratio * 3)) as B3EffortValue
}
function setEffort(v: number): void {
  b3Effort.value = Math.min(2, Math.max(0, v)) as B3EffortValue
}
function onSegsDown(e: PointerEvent): void {
  if (!effortEnabled.value) return
  dragging.value = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  b3Effort.value = stopFromClientX(e.clientX)
}
function onSegsMove(e: PointerEvent): void {
  if (dragging.value) b3Effort.value = stopFromClientX(e.clientX)
}
function onSegsUp(): void {
  dragging.value = false
}
</script>

<template>
  <div
    class="composer"
    data-test="composer"
    data-b3
    @paste="onPaste"
    @drop="onDrop"
    @dragover.prevent
  >
    <slot
      v-if="slashOpen"
      name="slash-menu"
      :matches="matches"
      :slash-index="slashIndex"
    />
    <div v-if="b3MockAttachments.length" class="preview-strip" data-test="b3-preview-strip">
      <div v-for="p in b3MockAttachments" :key="p.key" class="preview-item" data-test="b3-preview-item">
        <img v-if="p.previewUrl" :src="p.previewUrl" :alt="p.fileName" class="preview-thumb" />
        <span v-else class="preview-file" :title="p.fileName">{{ p.fileName }}</span>
        <button
          type="button"
          class="preview-remove"
          :aria-label="`移除 ${p.fileName}`"
          @click="b3RemoveMockAttachment(p.key)"
        >✕</button>
      </div>
      <span class="attach-count">{{ b3MockAttachments.length }}/4 个附件 · 单文件 ≤100MB · 原型仅本地预览，不真实上传</span>
    </div>
    <p v-if="attachmentStatus" class="argument-hint" role="status">{{ attachmentStatus }}</p>
    <p v-if="argumentHint" id="slash-argument-hint" class="argument-hint" data-test="slash-argument-hint" role="status">{{ argumentHint }}</p>
    <div class="c-capsule">
      <textarea
        ref="inputEl"
        :value="modelValue"
        data-test="input"
        rows="2"
        placeholder="发消息…（Enter 发送 / Shift+Enter 换行；输 / 弹命令补全）"
        aria-label="消息输入框"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="slashOpen"
        :aria-controls="slashOpen ? 'slash-command-menu' : undefined"
        :aria-activedescendant="slashOpen ? `slash-command-${slashIndex}` : undefined"
        :aria-describedby="argumentHint ? 'slash-argument-hint' : undefined"
        @input="onInput"
        @keydown="emit('keydown', $event)"
      ></textarea>
      <div class="c-dock">
        <button
          type="button"
          class="c-attach"
          data-test="b3-attach-btn"
          :disabled="connecting || streaming || disconnected || attachmentBusy"
          aria-label="添加附件"
          title="添加附件（原型：仅本地预览）"
          @mousedown.prevent
          @click="openFilePicker"
        >📎</button>
        <input
          ref="fileInput"
          type="file"
          multiple
          class="file-input"
          @change="onPick"
        />
        <div class="c-effort" :title="capNote">
          <template v-if="effortEnabled">
            <div
              ref="segsEl"
              class="c-segs"
              role="slider"
              tabindex="0"
              aria-label="推理强度"
              :aria-valuemin="0"
              :aria-valuemax="2"
              :aria-valuenow="b3Effort"
              :aria-valuetext="effLabel"
              @pointerdown="onSegsDown"
              @pointermove="onSegsMove"
              @pointerup="onSegsUp"
              @pointercancel="onSegsUp"
              @keydown.left.prevent="setEffort(b3Effort - 1)"
              @keydown.right.prevent="setEffort(b3Effort + 1)"
            >
              <span
                v-for="s in B3_EFFORT_STOPS"
                :key="s.value"
                class="c-seg"
                :class="{ on: b3Effort >= s.value, cur: b3Effort === s.value }"
              >{{ s.label }}</span>
            </div>
            <span v-if="cap === 'thinking-only'" class="c-zone">标准 · 深思＝开</span>
          </template>
          <span v-else class="c-effort-off">推理强度 · 不可用</span>
        </div>
        <div class="c-model-wrap">
          <button
            type="button"
            class="c-model-chip"
            data-test="b3-model-chip"
            :title="b3ActiveOption.effortNote"
            @mousedown.prevent
            @click="menuOpen = !menuOpen"
          >
            <span>{{ chipLabel }}</span>
            <span class="chip-caret">▲</span>
          </button>
          <div v-if="menuOpen" class="menu-backdrop" @click="menuOpen = false"></div>
          <div v-if="menuOpen" class="c-model-menu" role="listbox" aria-label="选择模型（上拉菜单）">
            <button
              v-for="o in B3_MODEL_OPTIONS"
              :key="`${o.providerId}/${o.modelId}`"
              type="button"
              role="option"
              :aria-selected="o === b3ActiveOption"
              class="c-model-item"
              :class="{ sel: o === b3ActiveOption }"
              :title="o.effortNote"
              @mousedown.prevent
              @click="pickModel(o.providerId, o.modelId)"
            >
              <span class="model-name">{{ o.name }}</span>
              <span class="model-id">{{ o.providerId ? o.providerId : '默认' }}</span>
              <span v-if="o === b3ActiveOption" class="model-check">✓</span>
            </button>
          </div>
        </div>
        <button
          type="button"
          class="c-send"
          data-test="send"
          :disabled="connecting || streaming || disconnected || attachmentBusy || rewindBusy || forkBusy"
          :title="connecting ? '正在连接' : streaming ? '正在生成回答' : disconnected ? '连接已断开' : rewindBusy ? '正在回退' : forkBusy ? '正在分叉' : '发送消息'"
          aria-label="发送消息"
          @click="emit('send')"
        >↑</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer { position: relative; display: flex; flex-direction: column; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--el-border-color); }
.argument-hint { width: 100%; max-width: 840px; margin: 0 auto; font-size: 12px; color: var(--el-text-color-secondary); }
.c-capsule { display: flex; flex-direction: column; width: 100%; max-width: 840px; margin: 0 auto; border: 1px solid var(--el-border-color); border-radius: 12px; background: var(--el-bg-color); }
.c-capsule:focus-within { border-color: var(--el-color-primary); }
.c-capsule textarea { display: block; width: 100%; border: none; outline: none; resize: none; min-height: 52px; max-height: 180px; overflow-y: auto; padding: 8px 10px 4px; background: transparent; box-sizing: border-box; font: inherit; }
.c-dock { display: flex; align-items: center; gap: 10px; padding: 6px 8px 7px; }
button:focus-visible, .c-segs:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }

.c-attach { padding: 4px 8px; background: transparent; border: none; border-radius: 6px; color: var(--el-text-color-regular); font-size: 16px; cursor: pointer; }
.c-attach:disabled { opacity: .4; cursor: default; }
.c-attach:hover:not(:disabled) { background: var(--el-fill-color); }
.file-input { display: none; }

.c-effort { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; }
.c-segs { display: flex; width: 240px; height: 22px; border: 1px solid var(--el-border-color); border-radius: 999px; overflow: hidden; cursor: pointer; touch-action: none; background: var(--el-fill-color-light); }
.c-seg { flex: 1; display: flex; align-items: center; justify-content: center; font-size: 10.5px; color: var(--el-text-color-secondary); border-right: 1px solid var(--el-border-color-lighter); user-select: none; }
.c-seg:last-child { border-right: none; }
.c-seg.on { background: var(--el-color-primary-light-8); color: var(--el-color-primary); }
.c-seg.cur { background: var(--el-color-primary); color: #fff; font-weight: 600; }
.c-zone { font-size: 10px; color: var(--el-color-warning); }
.c-effort-off { font-size: 11px; color: var(--el-text-color-placeholder); }

.c-model-wrap { position: relative; margin-left: auto; }
.c-model-chip { display: flex; align-items: center; gap: 6px; padding: 4px 10px; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color); border-radius: 999px; font-size: 12px; color: var(--el-text-color-regular); cursor: pointer; max-width: 190px; }
.c-model-chip:hover { border-color: var(--el-color-primary); color: var(--el-color-primary); }
.chip-caret { font-size: 9px; opacity: .7; }
.menu-backdrop { position: fixed; inset: 0; z-index: 29; }
.c-model-menu { position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 30; width: 280px; max-height: 300px; overflow-y: auto; background: var(--el-bg-color-overlay); border: 1px solid var(--el-border-color); border-radius: 10px; box-shadow: 0 -8px 30px rgba(0, 0, 0, .18); padding: 4px; }
.c-model-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent; border: none; border-radius: 7px; padding: 8px 10px; cursor: pointer; }
.c-model-item:hover, .c-model-item.sel { background: var(--el-fill-color); }
.model-name { font-size: 12.5px; color: var(--el-text-color-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-id { margin-left: auto; font-family: ui-monospace, monospace; font-size: 10.5px; color: var(--el-text-color-secondary); }
.model-check { color: var(--el-color-primary); font-weight: 700; }

.c-send { width: 34px; height: 34px; border-radius: 50%; border: none; background: var(--el-color-primary); color: #fff; font-size: 16px; cursor: pointer; flex-shrink: 0; }
.c-send:disabled { cursor: not-allowed; opacity: .55; }

.preview-strip { display: flex; width: 100%; max-width: 840px; margin: 0 auto; flex-wrap: wrap; align-items: center; gap: 8px; }
.preview-item { position: relative; display: flex; align-items: center; border: 1px solid var(--el-border-color); border-radius: 8px; padding: 4px; background: var(--el-fill-color-light); }
.preview-thumb { width: 48px; height: 48px; object-fit: cover; border-radius: 6px; display: block; }
.preview-file { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--el-text-color-regular); padding: 0 4px; }
.preview-remove { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%; border: none; background: var(--el-color-danger); color: #fff; font-size: 11px; line-height: 1; cursor: pointer; padding: 0; }
.attach-count { margin-left: auto; font-size: 12px; color: var(--el-text-color-secondary); }
</style>
