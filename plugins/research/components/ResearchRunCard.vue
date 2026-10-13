<script setup lang="ts">
// ResearchRunCard —— research 插件 web 面卡（#913 · 853 §6.2 / #867 定形）。
// 单管线纪律（#730/#752 §2.4）：本组件是归约产物的 custom-render 分支，非第二条管线——
// 只消费投影输出的 props（details/input/state/stage/workflow），不维护独立状态源。
// 进行态 = 单行双段徽标「workflow 中文名 · stage 中文名」；否决 FigureCard 式线性阶段条
//（W3 Send[] 并行扇出下「✓ 已完成」失真）。stage 值透传无前端白名单（server manifest
// progressStages 已是唯一关卡，853 §6.2）——未知值 fallback 裸名。
// vue 运行时 API 经 @/plugins/deps 桥（plugins 树禁裸包名 import 铁律，#791 对称面）。
import { computed } from '@/plugins/deps'
import { parseObjectish } from '@/plugins/api'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'

// props 契约 = @/plugins/api PluginToolRenderProps + workflow（853 §6.2 双段徽标语境面，
// research_run.progress 归约产物）。内联声明是实测结论：vue-tsc 可解析跨目录导入类型，
// 但 vite 生产 build 的 compiler-sfc resolveType 不行——契约漂移由组件测试与 api.ts
// 单源注释锁定（FigureCard 先例）。
const props = defineProps<{
  details: unknown
  input: unknown
  state: 'running' | 'done' | 'error'
  expanded: boolean
  isPartial?: boolean
  stage?: string
  toolCallId: string
  workflow?: string
}>()

// 呈现字典（不持拓扑序列——组件只做查表）。嵌套形状 = 853 §6.2「workflow→{stage→中文}」。
// 宽键 Record：透传纪律下字典是呈现面非校验面，新 stage 值忘配中文 → fallback 裸名不炸
// （853 §6.2「未知 stage 值 fallback 裸名」）。'_entry' 伪 workflow：入口帧尚无 workflow
// 语境时的 stage 中文（classify + 分支名帧——分支名与 workflow 同名，双段重复合并单段呈现）。
const WORKFLOW_LABELS: Record<string, string> = {
  ingest: '知识库构建',
  discover: '科学问题发现',
  hypothesize: '假说生成',
  experiment: '实验',
}
const WORKFLOW_STAGES: Record<string, Record<string, string>> = {
  _entry: {
    classify: '意图识别', // GLOSSARY 正典（intent classification）
    ingest: '知识库构建',
    discover: '科学问题发现',
    hypothesize: '假说生成',
    experiment: '实验',
  },
  ingest: {
    capture: '资料捕获',
    extract: '内容解析',
    create: '页面生成',
    validate: '结构校验',
    persist: '写入 wiki',
    verify: '入库验证',
    summary: '结果汇总',
  },
  discover: {
    resolveInputs: '解析输入',
    load: '加载论文',
    critic: '审读评估',
    evidenceGate: '证据闸门',
  },
  hypothesize: {
    contextPack: '上下文打包',
    bucket: '分桶生成',
    dedup: '去重合并',
    challenge: '挑战评审',
  },
  experiment: {
    preflight: '执行预检',
    design: '方案设计',
    spec: '方案落盘',
    audit: '方案自审',
    'plan-review': '方案待审批',
    collect: '结果对账',
    summarize: '对账汇总',
  },
}

const stageLabel = computed(() => {
  if (props.stage === undefined) return undefined
  const wf = props.workflow
  const nested = wf !== undefined ? WORKFLOW_STAGES[wf]?.[props.stage] : undefined
  return nested ?? WORKFLOW_STAGES._entry[props.stage] ?? props.stage
})
const workflowLabel = computed(() => {
  if (props.workflow === undefined) return undefined
  return WORKFLOW_LABELS[props.workflow] ?? props.workflow
})

// W4 调用③识别：phase 槽位从 tool.start input 推（853 §6.2「collect 调用③ = phase 徽标」）。
const isCollectPhase = computed(() => parseObjectish(props.input)?.phase === 'collect')

// 进行态徽标（running 专属；plan-review = W4 awaiting_review 唯一带引导提示条的两态之一）。
const badge = computed(() => {
  if (props.state !== 'running') return null
  if (isCollectPhase.value) return { text: '结果对账', hint: false } // 853 字面（无 workflow 前缀）
  if (props.stage === 'plan-review') return { text: `${workflowLabel.value ?? '实验'} · 方案待审批`, hint: true }
  if (stageLabel.value === undefined) return null
  if (workflowLabel.value === undefined || workflowLabel.value === stageLabel.value) {
    return { text: `${stageLabel.value}中…`, hint: false }
  }
  return { text: `${workflowLabel.value} · ${stageLabel.value}中…`, hint: false }
})

// ---- 终态解析（details 形状 = plugins/research/server.ts ResearchRunDetails 镜像：
// {workflow, status, artifactPages, summary?, clarify?}——引用形态不内联页内容）----
const STATUSES = ['completed', 'clarify', 'approved', 'plan_review_exhausted'] as const
interface ResearchDetails {
  status?: unknown
  artifactPages?: unknown
  summary?: unknown
  clarify?: unknown
}
const parsed = computed<ResearchDetails | null>(() => parseObjectish(props.details) as ResearchDetails | null)
const status = computed(() => {
  const s = parsed.value?.status
  return typeof s === 'string' && (STATUSES as readonly string[]).includes(s) ? s : null
})
const summary = computed(() => {
  const s = parsed.value?.summary
  return typeof s === 'string' && s !== '' ? s : ''
})

interface ArtifactPage { path: string; title: string }
const artifactPages = computed<ArtifactPage[]>(() => {
  const raw = parsed.value?.artifactPages
  if (!Array.isArray(raw)) return []
  return raw.flatMap((p): ArtifactPage[] => {
    if (p === null || typeof p !== 'object') return []
    const path = (p as Record<string, unknown>).path
    const title = (p as Record<string, unknown>).title
    if (typeof path !== 'string' || path === '') return []
    return [{ path, title: typeof title === 'string' && title !== '' ? title : path }]
  })
})

interface ClarifyCandidate { name: string; fit: string }
const clarify = computed<{ question: string; candidates: ClarifyCandidate[] } | null>(() => {
  const raw = parsed.value?.clarify
  if (raw === null || typeof raw !== 'object') return null
  const question = (raw as Record<string, unknown>).question
  const candidates = (raw as Record<string, unknown>).candidates
  return {
    question: typeof question === 'string' ? question : '',
    candidates: Array.isArray(candidates)
      ? candidates.flatMap((c): ClarifyCandidate[] => {
          if (c === null || typeof c !== 'object') return []
          const name = (c as Record<string, unknown>).name
          const fit = (c as Record<string, unknown>).fit
          if (typeof name !== 'string' || name === '') return []
          return [{ name, fit: typeof fit === 'string' ? fit : '' }]
        })
      : [],
  }
})

// 终态可呈现判定（clarify 需 clarify 块随行——缺失视为异形落兜底）。
const renderable = computed(() => {
  if (status.value === null) return false
  if (status.value === 'clarify') return clarify.value !== null
  return true
})

// details 异形（截断/未知 status/clarify 缺块）→ 原文兜底（FigureCard 同款纪律）。
const fallbackText = computed(() => {
  if (props.state !== 'done' || renderable.value) return ''
  const raw = props.details
  if (raw == null) return ''
  if (typeof raw === 'string') return raw
  try { return JSON.stringify(raw) } catch { return String(raw) }
})
</script>

<template>
  <div class="research-card" data-test="research-card">
    <!-- 进行态：单行双段徽标（853 §6.2）；progress 未到 → 通用文案 -->
    <template v-if="state === 'running'">
      <template v-if="badge">
        <p class="badge"><span class="b-dot">⟳</span><span data-test="research-badge">{{ badge.text }}</span></p>
        <p v-if="badge.hint" class="hint" data-test="research-badge-hint">方案待审批：请在下方审批卡批准，或拒绝并说明理由（修订走审批卡）</p>
      </template>
      <p v-else class="pending" data-test="research-pending">⟳ 工作流运行中…</p>
    </template>

    <!-- 失败态：通用错误面（failed 走 ToolRow state='error'，不入 status 值域） -->
    <p v-else-if="state === 'error'" class="failed" data-test="research-error">✗ 流程执行失败</p>

    <!-- 终态四值面（853 §6.2） -->
    <template v-else-if="status === 'completed'">
      <div data-test="research-completed">
        <p class="head ok">✓ 已完成</p>
        <ul v-if="artifactPages.length" class="artifacts">
          <li v-for="p in artifactPages" :key="p.path">
            <a :href="`/wiki?path=${encodeURIComponent(p.path)}`" target="_blank" rel="noopener" data-test="artifact-link">
              <span class="a-title">{{ p.title }}</span>
              <span class="a-path">{{ p.path }}</span>
            </a>
          </li>
        </ul>
        <MarkdownRenderer v-if="summary" :text="summary" :streaming="false" class="summary" data-test="research-summary" />
      </div>
    </template>
    <template v-else-if="status === 'clarify' && clarify">
      <div class="clarify" data-test="research-clarify">
        <p class="head warn">需要澄清（请用自然语言回复后重新发起）</p>
        <p v-if="clarify.question" class="q">{{ clarify.question }}</p>
        <ul v-if="clarify.candidates.length" class="candidates">
          <li v-for="c in clarify.candidates" :key="c.name">
            <strong>{{ c.name }}</strong><span v-if="c.fit"> — {{ c.fit }}</span>
          </li>
        </ul>
      </div>
    </template>
    <template v-else-if="status === 'approved'">
      <div data-test="research-approved">
        <p class="head ok">✓ 实验方案已批准</p>
        <MarkdownRenderer v-if="summary" :text="summary" :streaming="false" data-test="research-summary" />
      </div>
    </template>
    <template v-else-if="status === 'plan_review_exhausted'">
      <div class="exhausted" data-test="research-exhausted">
        <p class="head warn">⚠ 实验方案 3 轮审批未通过，流程终止（非错误——spec 保留供参考）</p>
        <MarkdownRenderer v-if="summary" :text="summary" :streaming="false" data-test="research-summary" />
      </div>
    </template>

    <!-- details 异形兜底（截断/未知 status） -->
    <p v-else-if="fallbackText" class="fallback" data-test="research-fallback">{{ fallbackText }}</p>
  </div>
</template>

<style scoped>
.research-card { min-width: 0; }
.badge { display: inline-flex; align-items: center; gap: 6px; margin: 4px 0; padding: 3px 12px; border-radius: 12px; background: var(--el-color-primary-light-9); color: var(--el-color-primary); font-size: 12.5px; font-weight: 600; }
.b-dot { display: inline-block; }
.hint { margin: 4px 0; padding: 6px 10px; border-radius: 6px; background: var(--el-color-warning-light-9); color: var(--el-color-warning); font-size: 12.5px; }
.pending, .failed { margin: 4px 0; font-size: 12.5px; }
.pending { color: var(--el-text-color-secondary); }
.failed { color: var(--el-color-danger); }
.head { margin: 4px 0; font-size: 12.5px; font-weight: 600; }
.head.ok { color: var(--el-color-success); }
.head.warn { color: var(--el-color-warning); }
.artifacts { list-style: none; margin: 4px 0; padding: 0; }
.artifacts li { margin: 2px 0; }
.artifacts a { display: inline-flex; flex-direction: column; gap: 1px; padding: 5px 10px; border: 1px solid var(--el-border-color); border-radius: 7px; text-decoration: none; max-width: 100%; }
.artifacts a:hover { border-color: var(--el-color-primary); }
.a-title { color: var(--el-color-primary); font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.a-path { color: var(--el-text-color-secondary); font-family: ui-monospace, monospace; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.summary { margin: 4px 0; font-size: 12.5px; }
.clarify .q { margin: 4px 0; font-size: 12.5px; }
.candidates { list-style: none; margin: 4px 0; padding: 0; font-size: 12.5px; }
.candidates li { margin: 2px 0; color: var(--el-text-color-regular); }
.exhausted { min-width: 0; }
.fallback { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; color: var(--el-text-color-secondary); }
</style>
