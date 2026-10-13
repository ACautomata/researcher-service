// W4 方案人审循环（#912 · 853 §5.1 · #852）：interrupt 挂起/恢复驱动的修订轮次循环——
// approve（可选附言）→ 返回批准结果续执行段；deny（必填理由）→ buildPlan(revisionReason)
// 修订重生成再挂审；第 PLAN_REVIEW_MAX_ROUNDS 轮 deny → plan_review_exhausted 结构化终局
// （run completed 非 failed——人审不通过是终局分支不是故障归因）。
//
// 循环与 LangGraph 的对接：hooks.interrupt 注入顶层 interrupt（经 autofigureDeps 桥）——
// 首次调用抛 GraphInterrupt 挂起主 agent 图；resume 重放时 interrupt() 返回历史 resume 值
// （scratchpad 队列按序对应各次调用）——修订历史零额外持久化，resume 队列即轮次状态。
// escalate 幂等由 buildPlanEscalationPayload 确定性 id 保证（experimentPlan.ts）。

import { PLAN_REVIEW_MAX_ROUNDS } from './values'
import { buildPlanEscalationPayload, planApprovalAuditRow } from './experimentPlan'
import type { ExperimentPlan, PlanApprovalAuditRow, PlanInterruptPayload } from './experimentPlan'
import type { ClarifyResult } from './clarify'

// resume 回执解析（RunCommand.decisions 契约——与 funnel parseResumeDecisions 同形态同语义：
// 缺缺失/畸形 fail-closed deny）。
export interface PlanDecision {
  readonly type: 'approve' | 'deny'
  readonly message?: string
}

export function parsePlanDecision(value: unknown): PlanDecision {
  const decisions = (value as { decisions?: unknown } | null | undefined)?.decisions
  if (Array.isArray(decisions) && decisions.length > 0) {
    const first = decisions[0] as { type?: unknown; message?: unknown } | null
    if (first?.type === 'approve') {
      return { type: 'approve', ...(typeof first.message === 'string' ? { message: first.message } : {}) }
    }
    if (first?.type === 'reject') {
      return {
        type: 'deny',
        ...(typeof first.message === 'string' && first.message.trim() !== '' ? { message: first.message } : {}),
      }
    }
  }
  return { type: 'deny' }
}

// interrupt 调用结果 + 历史轮判别（#912 review 修复）：LangGraph resume 队列语义——
// 每次 resume 重放消费历史 resume 值至队列末位前（末位对应新挂起点）；消费历史值的轮 =
// 历史轮（其审计已在前次重放落定），只当前轮（消费的 = 队列末位值）落审计行——
// 「3 轮修订 = 3 行 round 关联」（853 §5.2/§5.1 AC）在多轮重放下不破。挂起时 interrupt
// 抛 GraphInterrupt（包装层不返值，historical 无意义）。
export interface PlanInterruptResult {
  readonly value: unknown
  readonly historical: boolean
}

export interface PlanReviewHooks {
  /** 挂起点（注入 LangGraph 顶层 interrupt 包装；fake 测试注入队列消费者）。 */
  readonly interrupt: (payload: PlanInterruptPayload) => PlanInterruptResult
  /** 审计行落 tool_approval_logs（核心 sink 自动补 traceId/runId/userId）；仅当前轮调用。 */
  readonly recordAudit: (row: PlanApprovalAuditRow) => void | Promise<void>
}

export type PlanReviewResult =
  | { readonly outcome: 'approved'; readonly plan: ExperimentPlan; readonly note: string | undefined }
  | { readonly outcome: 'exhausted'; readonly lastReason: string; readonly planRef: string | undefined }
  | { readonly outcome: 'clarify'; readonly clarify: ClarifyResult }

// buildPlan 产物判别：ExperimentPlan 无 status 键——ClarifyResult.status='clarify' 单键判别。
const isClarify = (v: ExperimentPlan | ClarifyResult): v is ClarifyResult =>
  (v as ClarifyResult).status === 'clarify'

export async function runPlanReviewLoop(input: {
  readonly toolCallId: string
  readonly buildPlan: (revisionReason: string | undefined, round: number) => Promise<ExperimentPlan | ClarifyResult>
  readonly hooks: PlanReviewHooks
}): Promise<PlanReviewResult> {
  let round = 1
  let lastReason: string | undefined
  let lastPlanRef: string | undefined
  for (;;) {
    // 第 1 轮 revision=undefined（初次生成或 resume 重放短路——短路判定归 buildPlan 内部
    // 的图：本 round spec 已落盘即跳 LLM 直达本循环）；修订轮带上轮 deny 理由 + 轮次
    // （产物按 round 键控——experimentPlan.ts 头注）。
    const built = await input.buildPlan(lastReason, round)
    if (isClarify(built)) return { outcome: 'clarify', clarify: built }
    const plan = built
    lastPlanRef = plan.specRef
    const resume = input.hooks.interrupt(buildPlanEscalationPayload(input.toolCallId, plan, round))
    const decision = parsePlanDecision(resume.value)
    // 历史轮（重放消费已落定轮的 resume 值）跳过审计——防多轮重放重复落行。
    if (!resume.historical) {
      if (decision.type === 'approve') {
        await input.hooks.recordAudit(planApprovalAuditRow(plan, 'allow', decision.message, round))
        return { outcome: 'approved', plan, note: decision.message }
      }
      await input.hooks.recordAudit(planApprovalAuditRow(plan, 'deny', decision.message, round))
    } else if (decision.type === 'approve') {
      // 历史轮 approve = 队列语义异常（approve 是终局，不该有后续轮）——fail-fast。
      throw new Error('plan review 历史轮出现 approve——resume 队列语义违反（approve 应为终局轮）')
    }
    lastReason = decision.message ?? '未说明理由'
    if (round >= PLAN_REVIEW_MAX_ROUNDS) {
      return { outcome: 'exhausted', lastReason, planRef: lastPlanRef }
    }
    round++
  }
}
