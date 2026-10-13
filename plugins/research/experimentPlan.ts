// W4 实验方案 plan 数据面（#912 · 853 §5.1–§5.2 · #852 契约增量）：spec 落盘路径派生
// （幂等短路点哨兵）、planHash/escalation 确定性 id（resume 重放幂等）、审批载荷与审计行
// 引用快照。零 IO 纯逻辑——图与工具边界共用。
//
// 钉界：spec 落盘 lab = /lab/specs/<slug>/{design,spec,audit}.md——同请求同目录（重放与
// 修订覆盖天然幂等）；slug = fnv1a(request 面) 不承载语义（W1 slug 由论文标题派生有语义，
// W4 输入是问题+页集，无语义主干可派）。escalation.id 确定性 = fnv1a(toolCallId|planHash|
// round) 填 uuid v4 模板——resolveApproval 按 id 校验，重放必须稳定（funnel escalationMemos
// 先例的纯函数等价物——memo 不可行：工具 execute 重放是新函数实例，无 per-thread 存活面）。

import { PLAN_TEXT_MAX_CHARS } from './values'
import type { ResearchWorkflowRequest } from './graph'

// 方案人审审计 toolName 专值（853 §5.2——流程门禁特例行，避免与真实工具混淆）。
export const EXPERIMENT_PLAN_TOOL_NAME = 'experiment_plan'

// plan.summary 卡面摘要上限（审批卡渲染面——与 APPROVAL_SUMMARY_MAX_BYTES 同族口径，字符面）。
export const PLAN_SUMMARY_MAX_CHARS = 512

// spec 落盘根（853 §11.3B 拍板形态②：ctx.lab.write 窄口 /lab/specs/ 固定前缀）。
export const SPEC_ROOT = '/lab/specs'

// ---------------------------------------------------------------------------
// fnv1a 64-bit（FNV-1a offset basis / prime——载荷 id 与 planHash 共用原语）
// ---------------------------------------------------------------------------

export function fnv1aHex(input: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i) & 0xffff)
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

// 确定性 uuid 形派生器（16 hex 填 uuid v4 位型——非随机 uuid；escalation.id 重放必须稳定）。
const uuidShapedIdOf = (hex16: string): string =>
  `${hex16.slice(0, 8)}-${hex16.slice(8, 12)}-4${hex16.slice(13, 16)}-8${hex16.slice(15, 16)}${hex16.slice(0, 3)}-${hex16.slice(3)}${hex16}`.slice(0, 36)

// ---------------------------------------------------------------------------
// spec 落盘路径派生（幂等短路点哨兵——resume 重放检测本 round spec.md 已存在即跳 LLM 直达
// interrupt 点）
//
// round 键控（#912 review 修复）：产物按轮次落 /lab/specs/<slug>/r<N>/——多轮人审的
// resume 重放语义（LangGraph scratchpad 队列：每次重放消费历史 resume 值至队列末位前，
// 末位对应新挂起点）要求历史轮产物可逐轮读回：重放历史轮 → 本 round spec 已落盘 → 短路
// 零 LLM（含修订轮）；修订输入 = 上轮（round-1）spec + 用户理由（853 §5.1）；内容一致性 =
// 用户第 N 次审批卡面 spec = r<N> 文件，重放读回同一文件。round 超 PLAN_REVIEW_MAX_ROUNDS
// 无产物（第 3 轮 deny 即终局，不落 r4）。
// ---------------------------------------------------------------------------

const slugOf = (request: Pick<ResearchWorkflowRequest, 'question' | 'topic' | 'source_paths'>): string =>
  fnv1aHex(
    JSON.stringify({
      q: (request.question ?? request.topic ?? '').trim(),
      paths: [...(request.source_paths ?? [])].sort(),
    }),
  )

export const specDirOf = (request: Pick<ResearchWorkflowRequest, 'question' | 'topic' | 'source_paths'>): string =>
  `${SPEC_ROOT}/${slugOf(request)}`

export const roundDirOf = (
  request: Pick<ResearchWorkflowRequest, 'question' | 'topic' | 'source_paths'>,
  round: number,
): string => `${specDirOf(request)}/r${round}`

export const specPathOf = (
  request: Pick<ResearchWorkflowRequest, 'question' | 'topic' | 'source_paths'>,
  round = 1,
): string => `${roundDirOf(request, round)}/spec.md`

export const designPathOf = (
  request: Pick<ResearchWorkflowRequest, 'question' | 'topic' | 'source_paths'>,
  round = 1,
): string => `${roundDirOf(request, round)}/design.md`

export const auditPathOf = (
  request: Pick<ResearchWorkflowRequest, 'question' | 'topic' | 'source_paths'>,
  round = 1,
): string => `${roundDirOf(request, round)}/audit.md`

// collect 对账旁车（#912）：deliverables 结构化声明 + 输入页集——spec.md 是 LLM markdown
//（结构化面无法从正文确定性恢复），旁车 JSON 是 collect 确定性对账与 related_pages 的
// 消费面；与 spec.md 同目录同寿命（修订覆盖时一并重写）。
export const deliverablesPathOf = (
  request: Pick<ResearchWorkflowRequest, 'question' | 'topic' | 'source_paths'>,
  round = 1,
): string => `${roundDirOf(request, round)}/deliverables.json`

export interface SpecSidecar {
  readonly deliverables: readonly { readonly path: string; readonly success_criterion: string }[]
  readonly inputPages: readonly string[]
}

// ---------------------------------------------------------------------------
// plan 组装与 escalation 载荷
// ---------------------------------------------------------------------------

export interface ExperimentPlan {
  readonly title: string
  readonly summary: string
  /** spec 全文（审批卡 MarkdownRenderer 渲染面；几 KB 内联，无独立拉取面）。 */
  readonly text: string
  readonly round: number
  /** spec 落盘引用（审计 planRef + 批准后续执行段的消费面）。 */
  readonly specRef: string
  readonly planHash: string
}

export const planHashOf = (specContent: string): string => fnv1aHex(specContent)

// plan 组装（title/summary 从 spec 文档派生：H1 行 + 第 4 段优先实验节首行；截断面守上限）。
export function buildExperimentPlan(
  request: Pick<ResearchWorkflowRequest, 'question' | 'topic' | 'source_paths'>,
  spec: { readonly content: string },
  round = 1,
): ExperimentPlan {
  const intent = (request.question ?? request.topic ?? '').trim()
  const title = `实验方案：${intent === '' ? '未命名验证目标' : intent.slice(0, 60)}`
  // summary = spec 「## 1 任务背景」节正文首行（H1 恒「沙箱执行规格」零信息量，#912
  // review 修复）——卡面摘要给审批人一句话方案实质；无该节回退实验意图。
  const bgBody = /##\s+1\s+任务背景[^\n]*\n([\s\S]*?)(?=\n##\s|$)/.exec(spec.content)?.[1] ?? ''
  const bgLine = bgBody.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? ''
  const summarySrc = bgLine !== '' ? bgLine : intent
  const summary = (summarySrc === '' ? '沙箱执行规格方案' : summarySrc).slice(0, PLAN_SUMMARY_MAX_CHARS)
  // text 截断显式（P1-7）：超限截断 + 注记尾行（审批卡面可辨非全文；完整全文 = specRef
  // 的 spec.md——审批卡 MarkdownRenderer 渲染面）。
  const truncated = spec.content.length > PLAN_TEXT_MAX_CHARS
  const text = truncated
    ? `${spec.content.slice(0, PLAN_TEXT_MAX_CHARS)}\n\n> 注：spec 全文超 ${PLAN_TEXT_MAX_CHARS} 字符，卡面展示已截断；完整全文见 ${specPathOf(request, round)}。`
    : spec.content
  return {
    title,
    summary,
    text,
    round,
    specRef: specPathOf(request, round),
    planHash: planHashOf(spec.content),
  }
}

// escalation 载荷（#852 契约增量——kind 复用 tool-approval 常量、source=experiment-plan、
// plan 可选块、actionRequests=空数组：批准对象是方案不是调用）。payload v 沿 funnel
// APPROVAL_INTERRUPT_V 同值（载荷判别面 isApprovalInterruptPayload 只查 kind+escalation）。
export const PLAN_INTERRUPT_V = 1 as const

export interface PlanInterruptPayload {
  readonly v: typeof PLAN_INTERRUPT_V
  readonly kind: 'tool-approval'
  readonly escalation: {
    readonly id: string
    readonly source: 'experiment-plan'
    readonly toolCallId: string
    readonly toolName: typeof EXPERIMENT_PLAN_TOOL_NAME
    readonly toolCallSummary: string
    readonly plan: {
      readonly title: string
      readonly summary: string
      readonly text: string
      readonly round: number
    }
  }
  readonly actionRequests: readonly []
}

export function buildPlanEscalationPayload(toolCallId: string, plan: ExperimentPlan, round: number): PlanInterruptPayload {
  return {
    v: PLAN_INTERRUPT_V,
    kind: 'tool-approval',
    escalation: {
      // 确定性 id（resolveApproval 按 id 校验 pending——resume 重放必须产出同 id；
      // round 入参使第 N 轮审批与第 N-1 轮不撞）。
      id: uuidShapedIdOf(fnv1aHex(`${toolCallId}|${plan.planHash}|${round}`)),
      source: 'experiment-plan',
      toolCallId,
      toolName: EXPERIMENT_PLAN_TOOL_NAME,
      toolCallSummary: `${plan.title}（第 ${round}/3 轮）`,
      plan: { title: plan.title, summary: plan.summary, text: plan.text, round },
    },
    actionRequests: [],
  }
}

// ---------------------------------------------------------------------------
// 人审审计行（853 §5.2：落 tool_approval_logs——layer=human、decision 二值、toolName 专值、
// toolCall = 引用快照 {planTitle, planHash, planRef, round} 不存全文、reason = 附言/拒绝理由；
// 3 轮修订 = 3 行 round 关联）
// ---------------------------------------------------------------------------

export interface PlanApprovalAuditRow {
  readonly layer: 'human'
  readonly decision: 'allow' | 'deny'
  readonly toolName: typeof EXPERIMENT_PLAN_TOOL_NAME
  /** 规范化引用快照 JSON（planTitle/planHash/planRef/round——控体积不存全文）。 */
  readonly toolCall: string
  readonly reason: string | undefined
}

export function planApprovalAuditRow(
  plan: ExperimentPlan,
  decision: 'allow' | 'deny',
  reason: string | undefined,
  round: number,
): PlanApprovalAuditRow {
  return {
    layer: 'human',
    decision,
    toolName: EXPERIMENT_PLAN_TOOL_NAME,
    toolCall: JSON.stringify({ planTitle: plan.title, planHash: plan.planHash, planRef: plan.specRef, round }),
    reason: reason !== undefined && reason.trim() !== '' ? reason : undefined,
  }
}
