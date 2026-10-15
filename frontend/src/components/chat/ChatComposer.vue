<script setup lang="ts">
// 输入区「全内嵌舱」（#980 · B3 变体 C 定稿施工，#977 §③ 规格重写）+ 斜杠命令补全
//（#316：#340 拆分边界，props-in/emits-out 哑组件）。
// 结构：单胶囊体框外零控件——舱内顶排 textarea，底排从左到右 = 📎 附件、推理强度三段式
// 拖拽段控件、模型 chip（上拉菜单）、圆形发送键；附件预览条内移为舱内第一排。
// 斜杠菜单（slash-menu slot）由父注入表现；输入/键盘事件上抛。匹配计算（slashQuery/
// slashMatches/slashOpen）单一来源在 ChatView——本组件只收 matches/slashOpen props 渲染。
// #459-T2 #463：附件采集壳——粘贴/拖拽/文件选择三通道仅做「采 File 上抛」，压缩/校验/发送
// 逻辑全在宿主 ChatView；预览条只渲染宿主给的 pendingAttachments（含 previewUrl），移除上抛 key。
// #980 选择器面：模型清单/能力/映射注记全部来自 props（GET /models/available 服务端下发，
// 前端零映射表副本）；选择/换档只上抛（selectModel/setEffort），落库与生效语义在宿主。
import type { SlashOption } from '@/chat/useChatSession'
import type { PendingAttachment } from '@/chat/attachments'
import type { AvailableModelDTO } from '@/api/models'
import type { PreferredModelRef } from '@/api/sessions'
import { DEFAULT_EFFORT_TIER, EFFORT_STOPS, clampTier, tierLabel, type EffortTier } from '@/chat/effort'
import { computed, nextTick, ref, watch } from 'vue'

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
    // Codex #703 P1（F2）：回退在途——窗口内投影还是回退前的旧代，发送会被随后的 abandonActiveRun
    // 吞掉（用户消息与回复双双丢失），故发送键置灰。输入框/附件编辑不受限（草稿指纹守卫允许窗口内
    // 继续编辑，回填时新草稿原地保留）。
    rewindBusy?: boolean
    // #697：fork 在途——同 rewindBusy 语义（导航窗口内 send 会被切换冲掉），发送键置灰；
    // 输入框/附件编辑不受限。
    forkBusy?: boolean
    pendingAttachments?: PendingAttachment[]
    attachmentBusy?: boolean
    attachmentStatus?: string
    // #980：会话模型覆盖（null = 默认态，滑块置灰）+ 可选模型清单（服务端下发）+ 滑块会话内值。
    preferredModel?: PreferredModelRef | null
    modelOptions?: AvailableModelDTO[]
    effortTier?: EffortTier
  }>(),
  { pendingAttachments: () => [], modelOptions: () => [], effortTier: DEFAULT_EFFORT_TIER, preferredModel: null },
)

const emit = defineEmits<{
  'update:modelValue': [v: string]
  input: []
  send: []
  keydown: [e: KeyboardEvent]
  pickSlash: [alias: string]
  addFiles: [files: File[]]
  removeAttachment: [key: number]
  // 菜单选中模型（null = 「默认」清空覆盖，与 /model default 同语义）；换档上抛三档序 0-2。
  selectModel: [option: AvailableModelDTO | null]
  setEffort: [tier: EffortTier]
}>()

defineSlots<{
  'slash-menu'?: (props: { matches: SlashOption[]; slashIndex: number }) => unknown
}>()

// 门语义零改动（B2 锁定承诺）：原模板三处内联析取收拢为计算属性，逐字同义——📎/预览移除 =
// connecting||streaming||disconnected||attachmentBusy，发送另加 rewind/fork busy。
const attachDisabled = computed(
  () => props.connecting || props.streaming || props.disconnected || props.attachmentBusy,
)
const sendDisabled = computed(
  () => attachDisabled.value || props.rewindBusy || props.forkBusy,
)

// 真实用户输入（非程序化赋值）：上抛 update:modelValue（v-model）+ input（父复位菜单态）
function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value)
  emit('input')
}

// ---- 附件三通道采集（仅采 File 上抛，不处理）----
// 粘贴（剪贴板文件，截图直发）。
function onPaste(e: ClipboardEvent): void {
  const files = Array.from(e.clipboardData?.files ?? [])
  if (files.length) {
    e.preventDefault()
    emit('addFiles', files)
  }
}

// 拖拽释放（文件/图片拖入输入区）。dragover 须 preventDefault 才会触发 drop。
// #5：仅当拖入内容含文件时才 preventDefault——无文件（拖纯文本/链接）不拦截，保留浏览器原生
// 「拖文本到光标处插入」行为（旧 composer 无 drop handler，该路径曾可用）。
function onDrop(e: DragEvent): void {
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (!files.length) return
  e.preventDefault()
  emit('addFiles', files)
}

// 文件选择按钮 → 隐藏 file-input；选完上抛并复位（同名文件可再选）。
const fileInput = ref<HTMLInputElement | null>(null)
function openFilePicker(): void {
  fileInput.value?.click()
}
function onPick(e: Event): void {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (files.length) emit('addFiles', files)
  input.value = ''
}
const inputEl = ref<HTMLTextAreaElement | null>(null)
function resize(): void {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`
}
watch(() => props.modelValue, () => void nextTick(resize), { immediate: true })

// ---- 模型 chip + 上拉菜单（舱内 chip 上方弹出，#980）----
const menuOpen = ref(false)
// 覆盖坐标与清单行同判（activeOption 匹配 / 菜单选中态高亮共用同一实现）
function sameModel(a: PreferredModelRef | null | undefined, o: { providerId: string; modelId: string }): boolean {
  return a?.providerId === o.providerId && a?.modelId === o.modelId
}
// 当前生效选项：按覆盖坐标查服务端清单；悬挂覆盖（端点已删/清单外，ADR 0019 运行时常态数据）
// chip 回退显示 modelId 原文、无注记，滑块按可用呈现。
const activeOption = computed<AvailableModelDTO | null>(() => {
  const pm = props.preferredModel
  if (!pm) return null
  return props.modelOptions.find((o) => sameModel(pm, o)) ?? null
})
const chipLabel = computed(() => {
  const pm = props.preferredModel
  if (!pm) return '默认'
  return activeOption.value?.name ?? pm.modelId
})
const chipTitle = computed(() => activeOption.value?.effortNote ?? '')
function toggleMenu(): void {
  menuOpen.value = !menuOpen.value
}
function pickModel(option: AvailableModelDTO | null): void {
  menuOpen.value = false
  emit('selectModel', option)
}

// ---- 推理强度四态可视（B4 裁定）----
// 默认态（覆盖空）与 capability none 同形：段控件整体替换为置灰「推理强度 · 不可用」，
// tooltip 区分两态；thinking-only 段控件下方 warning 小字（简洁＝思考关 / 标准·深思＝开）；
// native 注记（就近映射/1:1）由服务端 effortNote 承载在控件 title（上拉菜单行 title 同源）。
const capability = computed(() => activeOption.value?.capability ?? null)
const effortEnabled = computed(() => props.preferredModel !== null && capability.value !== 'none')
const effortOffTitle = computed(() =>
  capability.value === 'none' ? '该模型无推理强度通道' : '先选模型再调推理强度',
)
const effortNote = computed(() => activeOption.value?.effortNote ?? '')
const thinkingNote = computed(() => (props.effortTier === 0 ? '简洁＝思考关' : '标准 · 深思＝开'))

// 三段式拖拽段控件：段即刻度，pointer 拖过即换档（三等分取段）；段内焦点 ←/→ 微调。
const segsEl = ref<HTMLElement | null>(null)
const dragging = ref(false)
function tierFromClientX(clientX: number): EffortTier {
  const el = segsEl.value
  if (!el) return props.effortTier
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0) return props.effortTier
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  return clampTier(Math.floor(ratio * EFFORT_STOPS.length))
}
function onSegsDown(e: PointerEvent): void {
  if (!effortEnabled.value) return
  dragging.value = true
  // 指针捕获让拖拽滑出控件仍收 move；无实现环境（jsdom）静默让位——拖拽语义不依赖它。
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* 环境不支持指针捕获 */
  }
  emit('setEffort', tierFromClientX(e.clientX))
}
function onSegsMove(e: PointerEvent): void {
  if (dragging.value) emit('setEffort', tierFromClientX(e.clientX))
}
function onSegsUp(): void {
  dragging.value = false
}
function onSegsKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowLeft') {
    e.preventDefault()
    emit('setEffort', clampTier(props.effortTier - 1))
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    emit('setEffort', clampTier(props.effortTier + 1))
  }
}
</script>

<template>
  <div
    class="composer"
    data-test="composer"
    @paste="onPaste"
    @drop="onDrop"
    @dragover.prevent
  >
    <!-- T07 斜杠命令补全（spec §9.4 / 原型 oc-chat-page.html）：输入 `/` 弹菜单（前缀过滤，
         cmd mono + 描述），点选/↑↓+Enter 选中填入后经普通 send() 发 `/cmd`。 -->
    <slot
      v-if="slashOpen"
      name="slash-menu"
      :matches="matches"
      :slash-index="slashIndex"
    />
    <p v-if="attachmentStatus" class="argument-hint" role="status" data-test="attachment-status">{{ attachmentStatus }}</p>
    <p v-if="argumentHint" id="slash-argument-hint" class="argument-hint" data-test="slash-argument-hint" role="status">{{ argumentHint }}</p>
    <!-- #980 全内嵌舱：单胶囊体，框外零控件；focus-within 边框转 primary -->
    <div class="pod" data-test="composer-pod">
      <!-- #980 附件预览条内移（B4 裁定）：舱内第一排（textarea 之上，横向 padding 对齐）；
           data-test 面与移除钮置灰条件原样保留 -->
      <div v-if="pendingAttachments.length" class="preview-strip" data-test="preview-strip">
        <div
          v-for="p in pendingAttachments"
          :key="p.key"
          class="preview-item"
          data-test="preview-item"
        >
          <img v-if="p.previewUrl" :src="p.previewUrl" :alt="p.att.fileName" class="preview-thumb" />
          <span v-else class="preview-file" :title="p.att.fileName">{{ p.att.fileName }}</span>
          <button
            type="button"
            class="preview-remove"
            data-test="preview-remove"
            :disabled="attachDisabled"
            :aria-label="`移除 ${p.att.fileName}`"
            @click="emit('removeAttachment', p.key)"
          >✕</button>
        </div>
        <span class="attach-count" data-test="attach-count">{{ pendingAttachments.length }}/4 个附件 · 单文件 ≤100MB</span>
      </div>
      <textarea
        ref="inputEl"
        :value="modelValue"
        data-test="input"
        rows="2"
        placeholder="发消息…（Enter 发送 / Shift+Enter 换行；输 / 弹命令补全；可粘贴/拖拽/选附件）"
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
      <div class="dock">
        <button
          type="button"
          class="attach-btn"
          data-test="attach-btn"
          :disabled="attachDisabled"
          aria-label="添加附件"
          @mousedown.prevent
          @click="openFilePicker"
        >📎</button>
        <input
          ref="fileInput"
          type="file"
          multiple
          data-test="file-input"
          class="file-input"
          @change="onPick"
        />
        <!-- 四态可视：默认态/none 置灰替换；thinking-only 注记小字；native 注记在 title -->
        <div class="effort" data-test="effort" :title="effortEnabled ? effortNote : undefined">
          <template v-if="effortEnabled">
            <div
              ref="segsEl"
              class="segs"
              data-test="effort-segs"
              role="slider"
              tabindex="0"
              aria-label="推理强度"
              :aria-valuemin="0"
              :aria-valuemax="EFFORT_STOPS.length - 1"
              :aria-valuenow="effortTier"
              :aria-valuetext="tierLabel(effortTier)"
              @pointerdown="onSegsDown"
              @pointermove="onSegsMove"
              @pointerup="onSegsUp"
              @pointercancel="onSegsUp"
              @keydown="onSegsKeydown"
            >
              <span
                v-for="s in EFFORT_STOPS"
                :key="s.tier"
                class="seg"
                :class="{ on: effortTier >= s.tier, cur: effortTier === s.tier }"
              >{{ s.label }}</span>
            </div>
            <span v-if="capability === 'thinking-only'" class="effort-zone" data-test="effort-note">{{ thinkingNote }}</span>
          </template>
          <span v-else class="effort-off" data-test="effort-off" :title="effortOffTitle">推理强度 · 不可用</span>
        </div>
        <div class="model-wrap">
          <button
            type="button"
            class="model-chip"
            data-test="model-chip"
            :title="chipTitle"
            aria-haspopup="listbox"
            :aria-expanded="menuOpen"
            @mousedown.prevent
            @click="toggleMenu"
          >
            <span class="chip-label">{{ chipLabel }}</span>
            <span class="chip-caret">▲</span>
          </button>
          <!-- 透明 backdrop 点击即关（菜单外任意点） -->
          <div v-if="menuOpen" class="menu-backdrop" data-test="model-menu-backdrop" @click="menuOpen = false"></div>
          <div v-if="menuOpen" class="model-menu" data-test="model-menu" role="listbox" aria-label="选择模型">
            <button
              type="button"
              role="option"
              class="model-item"
              data-test="model-item-default"
              :aria-selected="!preferredModel"
              :class="{ sel: !preferredModel }"
              title="清空覆盖，与 /model default 同语义"
              @mousedown.prevent
              @click="pickModel(null)"
            >
              <span class="model-name">默认</span>
              <span class="model-id">清空覆盖</span>
              <span v-if="!preferredModel" class="model-check">✓</span>
            </button>
            <button
              v-for="o in modelOptions"
              :key="`${o.providerId}/${o.modelId}`"
              type="button"
              role="option"
              class="model-item"
              data-test="model-item"
              :aria-selected="sameModel(preferredModel, o)"
              :class="{ sel: sameModel(preferredModel, o) }"
              :title="o.effortNote"
              @mousedown.prevent
              @click="pickModel(o)"
            >
              <span class="model-name">{{ o.name }}</span>
              <span class="model-id">{{ o.providerId }}</span>
              <span v-if="sameModel(preferredModel, o)" class="model-check">✓</span>
            </button>
          </div>
        </div>
        <button
          type="button"
          class="send"
          data-test="send"
          :disabled="sendDisabled"
          :title="attachmentBusy ? '正在处理附件' : connecting ? '正在连接' : streaming ? '正在生成回答' : disconnected ? '连接已断开' : rewindBusy ? '正在回退' : forkBusy ? '正在分叉' : '发送消息'"
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

/* #980 全内嵌舱：1px 边框 + 12px 圆角、页面底色；focus-within 边框转 primary */
.pod { display: flex; flex-direction: column; width: 100%; max-width: 840px; margin: 0 auto; border: 1px solid var(--el-border-color); border-radius: 12px; background: var(--el-bg-color); }
.pod:focus-within { border-color: var(--el-color-primary); }
.pod textarea { display: block; width: 100%; border: none; outline: none; resize: none; min-height: 52px; max-height: 180px; overflow-y: auto; padding: 8px 10px 4px; background: transparent; box-sizing: border-box; font: inherit; }

/* 舱内底排（左→右）：📎 → 推理强度段控件 → 模型 chip → 圆形发送键 */
.dock { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 6px 8px 7px; }
.dock button:focus-visible, .segs:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }

.attach-btn { padding: 4px 8px; background: transparent; border: none; border-radius: 6px; color: var(--el-text-color-regular); font-size: 16px; cursor: pointer; }
.attach-btn:disabled { opacity: .4; cursor: default; }
.attach-btn:hover:not(:disabled) { background: var(--el-fill-color); }
.file-input { display: none; }

.effort { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; }
.segs { display: flex; width: 240px; height: 22px; border: 1px solid var(--el-border-color); border-radius: 999px; overflow: hidden; cursor: pointer; touch-action: none; background: var(--el-fill-color-light); }
.seg { flex: 1; display: flex; align-items: center; justify-content: center; font-size: 10.5px; color: var(--el-text-color-secondary); border-right: 1px solid var(--el-border-color-lighter); user-select: none; }
.seg:last-child { border-right: none; }
.seg.on { background: var(--el-color-primary-light-8); color: var(--el-color-primary); }
.seg.cur { background: var(--el-color-primary); color: #fff; font-weight: 600; }
.effort-zone { font-size: 10px; color: var(--el-color-warning); }
.effort-off { font-size: 11px; color: var(--el-text-color-placeholder); }

.model-wrap { position: relative; margin-left: auto; }
.model-chip { display: flex; align-items: center; gap: 6px; padding: 4px 10px; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color); border-radius: 999px; font-size: 12px; color: var(--el-text-color-regular); cursor: pointer; max-width: 190px; }
.model-chip:hover { border-color: var(--el-color-primary); color: var(--el-color-primary); }
.chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip-caret { font-size: 9px; opacity: .7; }
.menu-backdrop { position: fixed; inset: 0; z-index: 29; }
/* 上拉菜单：舱内 chip 上方弹出（bottom: 100%+8px、右对齐），紧凑单行 */
.model-menu { position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 30; width: 280px; max-height: 300px; overflow-y: auto; background: var(--el-bg-color-overlay); border: 1px solid var(--el-border-color); border-radius: 10px; box-shadow: 0 -8px 30px rgba(0, 0, 0, .18); padding: 4px; }
.model-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent; border: none; border-radius: 7px; padding: 8px 10px; cursor: pointer; }
.model-item:hover, .model-item.sel { background: var(--el-fill-color); }
.model-name { font-size: 12.5px; color: var(--el-text-color-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-id { margin-left: auto; font-family: ui-monospace, monospace; font-size: 10.5px; color: var(--el-text-color-secondary); }
.model-check { color: var(--el-color-primary); font-weight: 700; }

.send { width: 34px; height: 34px; border-radius: 50%; border: none; background: var(--el-color-primary); color: #fff; font-size: 16px; cursor: pointer; flex-shrink: 0; }
.send:disabled { cursor: not-allowed; opacity: .55; }

/* #980 预览条内移：舱内第一排，横向 padding 对齐 textarea */
.preview-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 10px 0; }
.preview-item { position: relative; display: flex; align-items: center; border: 1px solid var(--el-border-color); border-radius: 8px; padding: 4px; background: var(--el-fill-color-light); }
.preview-thumb { width: 48px; height: 48px; object-fit: cover; border-radius: 6px; display: block; }
.preview-file { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--el-text-color-regular); padding: 0 4px; }
.preview-remove { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%; border: none; background: var(--el-color-danger); color: #fff; font-size: 11px; line-height: 1; cursor: pointer; padding: 0; }
.attach-count { margin-left: auto; font-size: 12px; color: var(--el-text-color-secondary); }
</style>
