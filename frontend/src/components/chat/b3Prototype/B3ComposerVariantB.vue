<!-- B3 原型（#933）变体 B「语境头栏」——一次性原型代码，勿引为生产实现。
     结构主张：「对谁说、想多深」先于「写什么」——模型 chip 与推理强度标尺升到输入框
     上方的语境头栏（信息层级：先声明上下文，再落笔），宽标尺带刻度与就近映射注记；
     📎 内移为输入框内部左下角浮动图标，发送键内移为框内右下圆形按钮——框外无任何控件。
     mock 只读：附件本地预览不触上传端点，模型/强度只写内存态不落 preferredModelJson。 -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { SlashOption } from '@/chat/useChatSession'
import { B3_EFFORT_STOPS, B3_MODEL_OPTIONS, B3_DEFAULT_OPTION, type B3EffortValue, type B3ModelOption } from './b3Presets'
import {
  b3ActiveOption,
  b3AddMockAttachments,
  b3Effort,
  b3MockAttachments,
  b3RemoveMockAttachment,
  b3SelectedModel,
} from './b3State'

defineOptions({ name: 'B3ComposerVariantB' })

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

// ---- 模型上拉菜单（头栏 chip 向上弹出；按 provider 分组）----
const menuOpen = ref(false)
const chipLabel = computed(() => (b3SelectedModel.value ? b3ActiveOption.value.name : '默认'))
const menuGroups = computed<{ header: string; options: B3ModelOption[] }[]>(() => {
  const groups = [{ header: '覆盖', options: [B3_DEFAULT_OPTION] }]
  for (const o of B3_MODEL_OPTIONS.slice(1)) {
    let group = groups.find((g) => g.header === o.providerId)
    if (!group) {
      group = { header: o.providerId, options: [] }
      groups.push(group)
    }
    group.options.push(o)
  }
  return groups
})
function pickModel(providerId: string, modelId: string): void {
  b3SelectedModel.value = providerId ? { providerId, modelId } : null
  menuOpen.value = false
}

// ---- 推理强度（宽标尺：刻度 + 就近映射注记；能力映射照 B2 决议）----
const cap = computed(() => b3ActiveOption.value.capability)
const effortEnabled = computed(() => cap.value !== 'none')
const capNote = computed(() => b3ActiveOption.value.effortNote)
const effLabel = computed(() => B3_EFFORT_STOPS[b3Effort.value].label)
const trackEl = ref<HTMLElement | null>(null)
const dragging = ref(false)
function stopFromClientX(clientX: number): B3EffortValue {
  const el = trackEl.value
  if (!el) return b3Effort.value
  const rect = el.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  return Math.round(ratio * 2) as B3EffortValue
}
function setEffort(v: number): void {
  b3Effort.value = Math.min(2, Math.max(0, v)) as B3EffortValue
}
function onTrackDown(e: PointerEvent): void {
  if (!effortEnabled.value) return
  dragging.value = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  b3Effort.value = stopFromClientX(e.clientX)
}
function onTrackMove(e: PointerEvent): void {
  if (dragging.value) b3Effort.value = stopFromClientX(e.clientX)
}
function onTrackUp(): void {
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
    <div class="b-col">
      <div class="b-bar">
        <div class="b-model-wrap">
          <button
            type="button"
            class="b-model-chip"
            data-test="b3-model-chip"
            :title="b3ActiveOption.effortNote"
            @mousedown.prevent
            @click="menuOpen = !menuOpen"
          >
            <span class="chip-k">模型</span>
            <span class="chip-v">{{ chipLabel }}</span>
            <span class="chip-caret">▲</span>
          </button>
          <div v-if="menuOpen" class="menu-backdrop" @click="menuOpen = false"></div>
          <div v-if="menuOpen" class="b-model-menu" role="listbox" aria-label="选择模型（上拉菜单）">
            <template v-for="g in menuGroups" :key="g.header">
              <div class="group-header">{{ g.header }}</div>
              <button
                v-for="o in g.options"
                :key="`${o.providerId}/${o.modelId}`"
                type="button"
                role="option"
                :aria-selected="o === b3ActiveOption"
                class="model-item"
                :class="{ sel: o === b3ActiveOption }"
                @mousedown.prevent
                @click="pickModel(o.providerId, o.modelId)"
              >
                <span class="model-name">{{ o.name }}</span>
                <span class="model-id">{{ o.providerId ? `${o.providerId}/${o.modelId}` : '清空覆盖' }}</span>
                <span class="model-note">{{ o.effortNote }}</span>
                <span v-if="o === b3ActiveOption" class="model-check">✓</span>
              </button>
            </template>
          </div>
        </div>
        <div class="b-effort" :title="capNote">
          <template v-if="effortEnabled">
            <span class="b-effort-k">推理强度<span class="b-effort-v">{{ effLabel }}</span></span>
            <div class="b-ruler-zone">
              <div
                ref="trackEl"
                class="b-ruler"
                role="slider"
                tabindex="0"
                aria-label="推理强度"
                :aria-valuemin="0"
                :aria-valuemax="2"
                :aria-valuenow="b3Effort"
                :aria-valuetext="effLabel"
                @pointerdown="onTrackDown"
                @pointermove="onTrackMove"
                @pointerup="onTrackUp"
                @pointercancel="onTrackUp"
                @keydown.left.prevent="setEffort(b3Effort - 1)"
                @keydown.right.prevent="setEffort(b3Effort + 1)"
              >
                <div class="b-fill" :style="{ width: `${(b3Effort / 2) * 100}%` }"></div>
                <span
                  v-for="s in B3_EFFORT_STOPS"
                  :key="s.value"
                  class="b-tick"
                  :class="{ on: b3Effort >= s.value }"
                  :style="{ left: `${(s.value / 2) * 100}%` }"
                ></span>
                <span class="b-thumb" :style="{ left: `${(b3Effort / 2) * 100}%` }"></span>
              </div>
              <div class="b-stops">
                <span :class="{ on: b3Effort === 0 }">简洁</span>
                <span :class="{ on: b3Effort === 1 }">标准</span>
                <span :class="{ on: b3Effort === 2 }">深思</span>
              </div>
              <div v-if="cap === 'thinking-only'" class="b-zones">
                <span class="zone-off">简洁＝思考关</span>
                <span class="zone-open">标准 · 深思＝思考开</span>
              </div>
            </div>
            <span class="b-note">{{ capNote }}</span>
          </template>
          <span v-else class="b-effort-off">推理强度 · {{ capNote }}</span>
        </div>
      </div>
      <div class="b-box">
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
        <button
          type="button"
          class="b-attach"
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
        <button
          type="button"
          class="b-send"
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
.b-col { display: flex; flex-direction: column; width: 100%; max-width: 840px; margin: 0 auto; gap: 8px; }
.b-bar { display: flex; align-items: center; gap: 14px; padding: 7px 12px; border: 1px solid var(--el-border-color-lighter); border-radius: 10px; background: var(--el-fill-color-light); }
button:focus-visible, .b-ruler:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }

.b-model-wrap { position: relative; }
.b-model-chip { display: flex; align-items: center; gap: 6px; padding: 5px 11px; background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-radius: 8px; font-size: 12.5px; color: var(--el-text-color-regular); cursor: pointer; max-width: 260px; }
.b-model-chip:hover { border-color: var(--el-color-primary); }
.chip-k { color: var(--el-text-color-secondary); font-size: 11px; }
.chip-v { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.chip-caret { font-size: 9px; opacity: .7; }
.menu-backdrop { position: fixed; inset: 0; z-index: 29; }
.b-model-menu { position: absolute; left: 0; bottom: calc(100% + 8px); z-index: 30; width: 380px; max-height: 340px; overflow-y: auto; background: var(--el-bg-color-overlay); border: 1px solid var(--el-border-color); border-radius: 10px; box-shadow: 0 -8px 30px rgba(0, 0, 0, .18); padding: 4px; }
.group-header { padding: 7px 10px 3px; font-family: ui-monospace, monospace; font-size: 10.5px; letter-spacing: .5px; text-transform: uppercase; color: var(--el-text-color-secondary); }
.model-item { position: relative; display: grid; grid-template-columns: 1fr auto; gap: 1px 10px; width: 100%; text-align: left; background: transparent; border: none; border-radius: 7px; padding: 7px 10px; cursor: pointer; }
.model-item:hover, .model-item.sel { background: var(--el-fill-color); }
.model-name { font-size: 13px; color: var(--el-text-color-primary); }
.model-id { font-family: ui-monospace, monospace; font-size: 11px; color: var(--el-text-color-secondary); justify-self: end; }
.model-note { grid-column: 1 / 2; font-size: 11px; color: var(--el-text-color-secondary); }
.model-check { position: absolute; right: 10px; bottom: 8px; color: var(--el-color-primary); font-weight: 700; }

.b-effort { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; }
.b-effort-k { font-size: 11.5px; color: var(--el-text-color-secondary); white-space: nowrap; }
.b-effort-v { margin-left: 4px; color: var(--el-color-primary); font-weight: 700; }
.b-ruler-zone { flex: 1; min-width: 0; max-width: 380px; }
.b-ruler { position: relative; height: 14px; cursor: pointer; touch-action: none; }
.b-ruler::before { content: ''; position: absolute; left: 0; right: 0; top: 6px; height: 3px; border-radius: 2px; background: var(--el-fill-color-dark); }
.b-fill { position: absolute; left: 0; top: 6px; height: 3px; border-radius: 2px; background: var(--el-color-primary); }
.b-tick { position: absolute; top: 3px; width: 2px; height: 9px; margin-left: -1px; border-radius: 1px; background: var(--el-fill-color-dark); }
.b-tick.on { background: var(--el-color-primary); }
.b-thumb { position: absolute; top: 2px; width: 11px; height: 11px; margin-left: -5px; border-radius: 50%; background: var(--el-color-primary); border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.25); box-sizing: border-box; }
.b-stops { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--el-text-color-secondary); }
.b-stops span.on { color: var(--el-color-primary); font-weight: 600; }
.b-zones { display: flex; justify-content: space-between; margin-top: 1px; font-size: 10px; color: var(--el-text-color-placeholder); }
.b-zones .zone-open { width: 50%; text-align: right; color: var(--el-color-warning); }
.b-note { font-size: 11px; color: var(--el-text-color-secondary); max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.b-effort-off { font-size: 11.5px; color: var(--el-text-color-placeholder); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.b-box { position: relative; border: 1px solid var(--el-border-color); border-radius: 10px; background: var(--el-bg-color); }
.b-box:focus-within { border-color: var(--el-color-primary); }
.b-box textarea { display: block; width: 100%; border: none; outline: none; resize: none; min-height: 60px; max-height: 180px; overflow-y: auto; padding: 8px 10px 46px; background: transparent; box-sizing: border-box; font: inherit; }
.b-attach { position: absolute; left: 8px; bottom: 8px; padding: 4px 8px; background: transparent; border: none; border-radius: 6px; color: var(--el-text-color-regular); font-size: 16px; cursor: pointer; }
.b-attach:disabled { opacity: .4; cursor: default; }
.b-attach:hover:not(:disabled) { background: var(--el-fill-color); }
.file-input { display: none; }
.b-send { position: absolute; right: 8px; bottom: 8px; width: 34px; height: 34px; border-radius: 50%; border: none; background: var(--el-color-primary); color: #fff; font-size: 16px; cursor: pointer; }
.b-send:disabled { cursor: not-allowed; opacity: .55; }

.preview-strip { display: flex; width: 100%; max-width: 840px; margin: 0 auto; flex-wrap: wrap; align-items: center; gap: 8px; }
.preview-item { position: relative; display: flex; align-items: center; border: 1px solid var(--el-border-color); border-radius: 8px; padding: 4px; background: var(--el-fill-color-light); }
.preview-thumb { width: 48px; height: 48px; object-fit: cover; border-radius: 6px; display: block; }
.preview-file { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--el-text-color-regular); padding: 0 4px; }
.preview-remove { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%; border: none; background: var(--el-color-danger); color: #fff; font-size: 11px; line-height: 1; cursor: pointer; padding: 0; }
.attach-count { margin-left: auto; font-size: 12px; color: var(--el-text-color-secondary); }
</style>
