<script setup lang="ts">
// FigureCard —— AutoFigure 插件 web 面图卡（#799 · story 50/51，#752 §2.4 / #744 §10 票 5）。
// 单管线纪律（#730/#752 §2.4）：本组件是归约产物的 custom-render 分支，非第二条管线——
// 只消费投影输出的 props（details/input/state/stage），不维护独立状态源；预览/下载的
// blob 拉取是渲染层只读 IO（幂等、实时与回放同一代码路径，#744 §4.2 R5）。
//
// 进行态装饰（isPartial/stage）仅 running 态构造（ToolLine 传入；终态/回放不构造）——
// 终态卡面与刷新回放天然零差异。details 为引用形态 {figureId,state,previewReady}
// （#744 §4.2 Q9：≤4KB 截断面）；异形（截断/缺 figureId）→ 原文兜底。
// vue 运行时 API 经 @/plugins/deps 桥（plugins 树禁裸包名 import 铁律，#791 对称面）。
import { computed, onBeforeUnmount, ref, watch } from '@/plugins/deps'
import { FIGURE_RUN_STAGES } from '@/chat/projection'
import { getFigurePngBlob, getFigureSvgBlob } from '@/api/figures'

// props 契约 = @/plugins/api PluginToolRenderProps 同形（内联声明是实测结论：vue-tsc 可解析
// 跨目录导入类型，但 vite 生产 build 的 compiler-sfc resolveType 不行——build 实测失败；
// 契约漂移由组件测试与 api.ts 单源注释锁定）。
const props = defineProps<{
  details: unknown
  input: unknown
  state: 'running' | 'done' | 'error'
  expanded: boolean
  isPartial?: boolean
  stage?: string
  toolCallId: string
}>()

// stage 中文呈现序 = FIGURE_RUN_STAGES 单源顺序（镜像 server figureAudit.ts 六值）。
const STAGE_LABELS: Record<string, string> = {
  generating: '生成',
  segmenting: '分割',
  preparing: '准备',
  templating: '模板',
  assembling: '装配',
  rendering: '渲染',
}
const stages = FIGURE_RUN_STAGES.map((s) => ({ key: s, label: STAGE_LABELS[s] ?? s }))
const stageIndex = computed(() => (props.stage ? stages.findIndex((s) => s.key === props.stage) : -1))

// details 容错解析：ToolLine 已 JSON.parse 过对象为主；字符串（异形源/直接挂载）再试一次，
// 失败 → null（走兜底）。
interface FigureDetails {
  figureId?: unknown
  state?: unknown
  previewReady?: unknown
}
const parsed = computed<FigureDetails | null>(() => {
  const raw = props.details
  if (raw !== null && typeof raw === 'object') return raw as FigureDetails
  if (typeof raw === 'string' && raw !== '') {
    try {
      const v: unknown = JSON.parse(raw)
      return v !== null && typeof v === 'object' ? (v as FigureDetails) : null
    } catch {
      return null
    }
  }
  return null
})
const figureId = computed(() => {
  const id = parsed.value?.figureId
  return typeof id === 'string' && id !== '' ? id : ''
})

// ---- 预览状态机（渲染层只读 IO）：previewReady → PNG，缺省/失败降级 SVG（<img> blob URL，
// 脚本不执行 #744 §4.2）；全失败 → 占位。toolCallId+figureId 变更即重拉，token 竞态守卫。
const previewUrl = ref('')
const previewMissing = ref(false)
let loadToken = 0
function setPreview(blob: Blob): void {
  const url = URL.createObjectURL(blob)
  previewUrl.value = url
  previewMissing.value = false
}
async function loadPreview(): Promise<void> {
  const token = ++loadToken
  revokePreview()
  previewUrl.value = ''
  previewMissing.value = false
  if (props.state !== 'done' || figureId.value === '') return
  const id = figureId.value
  const wantPng = parsed.value?.previewReady === true
  const pull = async (kind: 'png' | 'svg'): Promise<Blob> =>
    kind === 'png' ? getFigurePngBlob(id) : getFigureSvgBlob(id, false)
  try {
    const blob = wantPng ? await pull('png') : await pull('svg')
    if (token !== loadToken) return
    setPreview(blob)
  } catch {
    if (!wantPng) {
      if (token !== loadToken) return
      previewMissing.value = true
      return
    }
    try {
      const blob = await pull('svg')
      if (token !== loadToken) return
      setPreview(blob)
    } catch {
      if (token !== loadToken) return
      previewMissing.value = true
    }
  }
}
function revokePreview(): void {
  if (previewUrl.value !== '') URL.revokeObjectURL(previewUrl.value)
}
watch(() => [props.state, figureId.value, parsed.value?.previewReady], loadPreview, { immediate: true })
onBeforeUnmount(revokePreview)

// 下载 final SVG（产物面独立于预览态——预览缺失仍可下载重试）。
const downloading = ref(false)
async function downloadSvg(): Promise<void> {
  if (figureId.value === '' || downloading.value) return
  downloading.value = true
  try {
    const blob = await getFigureSvgBlob(figureId.value, true)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `figure-${figureId.value}.svg`
    a.click()
    URL.revokeObjectURL(url)
  } finally {
    downloading.value = false
  }
}

// details 异形（终态拿不到 figureId——4KB 截断/异常载荷）→ 原文兜底。
const fallbackText = computed(() => {
  if (figureId.value !== '') return ''
  const raw = props.details
  if (raw == null) return ''
  if (typeof raw === 'string') return raw
  try {
    return JSON.stringify(raw)
  } catch {
    return String(raw)
  }
})
</script>

<template>
  <div class="figure-card" data-test="figure-card">
    <!-- 进行态：六 stage 阶段条（story 50）；progress 未到（无 stage）→ 泛生成中 -->
    <template v-if="state === 'running'">
      <ol v-if="stageIndex >= 0" class="stages" data-test="figure-stage-bar">
        <li
          v-for="(s, i) in stages"
          :key="s.key"
          data-test="figure-stage-item"
          :class="{ active: i === stageIndex, done: i < stageIndex }"
        >
          <span class="s-dot">{{ i < stageIndex ? '✓' : i === stageIndex ? '⟳' : '' }}</span>
          {{ s.label }}
        </li>
      </ol>
      <p v-else class="pending" data-test="figure-pending">⟳ 正在生成图…</p>
    </template>

    <!-- 失败态 -->
    <p v-else-if="state === 'error'" class="failed" data-test="figure-error">✗ 图生成失败</p>

    <!-- 终态：预览 + 下载 + 幂等提示（story 50/51） -->
    <template v-else-if="figureId">
      <img
        v-if="previewUrl"
        class="preview"
        :src="previewUrl"
        alt="figure 预览"
        data-test="figure-preview"
      />
      <p v-else-if="previewMissing" class="missing" data-test="figure-missing">预览暂不可用</p>
      <div class="actions">
        <button class="dl" data-test="figure-download" :disabled="downloading" @click="downloadSvg">
          {{ downloading ? '下载中…' : '下载 SVG' }}
        </button>
      </div>
      <p class="idempotency" data-test="figure-idempotency">相同描述重复生成会复用既有 Figure 引用，不重复计费</p>
    </template>

    <!-- details 异形兜底（截断/缺 figureId） -->
    <p v-else-if="fallbackText" class="fallback" data-test="figure-fallback">{{ fallbackText }}</p>
  </div>
</template>

<style scoped>
.figure-card { min-width: 0; }
.stages { display: flex; flex-wrap: wrap; gap: 4px 14px; list-style: none; margin: 0; padding: 4px 0; font-size: 12.5px; }
.stages li { display: flex; align-items: center; gap: 4px; color: var(--el-text-color-placeholder); }
.stages li.done { color: var(--el-color-success); }
.stages li.active { color: var(--el-color-primary); font-weight: 600; }
.s-dot { width: 1.2em; display: inline-block; text-align: center; }
.pending, .failed, .missing { margin: 4px 0; font-size: 12.5px; }
.failed { color: var(--el-color-danger); }
.missing { color: var(--el-text-color-secondary); }
.preview { display: block; max-width: 100%; max-height: 320px; border: 1px solid var(--el-border-color); border-radius: 6px; background: #fff; margin: 4px 0; }
.actions { margin: 6px 0 2px; }
.dl { cursor: pointer; border: 1px solid var(--el-border-color); border-radius: 6px; background: var(--el-bg-color); padding: 3px 12px; font-size: 12.5px; }
.dl:hover { border-color: var(--el-color-primary); color: var(--el-color-primary); }
.dl:disabled { opacity: 0.6; cursor: default; }
.idempotency { margin: 4px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }
.fallback { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; color: var(--el-text-color-secondary); }
</style>
