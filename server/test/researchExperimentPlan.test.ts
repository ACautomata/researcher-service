// #912 S3：W4 plan 数据面纯逻辑——spec 落盘路径派生（幂等短路点哨兵）/ planHash /
// escalation 载荷构造（experiment-plan 源 + plan{title,summary,text,round} + 确定性 id）
// / 审计行引用快照（{planTitle, planHash, planRef, round} 不存全文——853 §5.2 控体积口径）。
import { describe, expect, it } from 'vitest'
import {
  roundDirOf,
  specDirOf,
  specPathOf,
  fnv1aHex,
  planHashOf,
  buildExperimentPlan,
  buildPlanEscalationPayload,
  planApprovalAuditRow,
  EXPERIMENT_PLAN_TOOL_NAME,
  PLAN_SUMMARY_MAX_CHARS,
} from '../../plugins/research/experimentPlan'
import { PLAN_TEXT_MAX_CHARS } from '../../plugins/research/values'
import { PLAN_REVIEW_MAX_ROUNDS } from '../../plugins/research/values'
import { validSpecDoc } from './researchFixtures'

const REQUEST = { workflow: 'experiment', question: '验证能量分数判据', source_paths: ['critics/robust-ood.md'] } as const

describe('W4 spec 落盘路径派生（幂等短路点哨兵——853 §5.1）', () => {
  it('路径 = /lab/specs/<slug>/r<N>/spec.md（round 键控）：同请求同轮同路径；轮次漂移目录漂移', () => {
    const a = specPathOf(REQUEST)
    const b = specPathOf({ ...REQUEST, question: '验证能量分数判据' })
    expect(a).toBe(b)
    expect(a).toMatch(/^\/lab\/specs\/[0-9a-f]+\/r1\/spec\.md$/)
    expect(specPathOf(REQUEST, 2)).toMatch(/\/r2\/spec\.md$/)
  })

  it('slug 随输入漂移：问题或输入页不同 → 目录不同（并行实验不互踩）', () => {
    expect(specPathOf(REQUEST)).not.toBe(specPathOf({ ...REQUEST, question: '另一个实验' }))
    expect(specPathOf(REQUEST)).not.toBe(
      specPathOf({ ...REQUEST, source_paths: ['idea-cards/energy-score.md'] }),
    )
  })

  it('roundDirOf 与 specPathOf 同源（三件产物 + 旁车同轮目录）', () => {
    expect(specPathOf(REQUEST, 2)).toBe(`${specDirOf(REQUEST)}/r2/spec.md`)
    expect(roundDirOf(REQUEST, 3)).toBe(`${specDirOf(REQUEST)}/r3`)
  })
})

describe('W4 planHash / escalation 载荷（#852 契约增量：source=experiment-plan + plan 块）', () => {
  it('planHash：spec 内容 FNV-1a hex（内容变 hash 变——审计快照引用）', () => {
    const h1 = planHashOf('spec-a')
    expect(h1).toMatch(/^[0-9a-f]{16}$/)
    expect(h1).not.toBe(planHashOf('spec-b'))
  })

  it('载荷：kind=tool-approval + source=experiment-plan + actionRequests=空数组（批准对象是方案不是调用）', () => {
    const spec = validSpecDoc()
    const plan = buildExperimentPlan(REQUEST, spec)
    const payload = buildPlanEscalationPayload('tc-1', plan, 1)
    expect(payload.kind).toBe('tool-approval')
    expect(payload.escalation.source).toBe('experiment-plan')
    expect(payload.escalation.toolCallId).toBe('tc-1')
    expect(payload.escalation.toolName).toBe(EXPERIMENT_PLAN_TOOL_NAME)
    expect(payload.actionRequests).toEqual([])
  })

  it('plan 块：{title, summary, text, round}——text ≤ PLAN_TEXT_MAX_CHARS（几 KB 内联面），round 透传', () => {
    const spec = validSpecDoc()
    const plan = buildExperimentPlan(REQUEST, spec)
    expect(plan.round).toBe(1)
    expect(plan.text.length).toBeLessThanOrEqual(PLAN_TEXT_MAX_CHARS)
    expect(plan.title).toContain('实验方案')
    expect(plan.summary.length).toBeLessThanOrEqual(PLAN_SUMMARY_MAX_CHARS)

    const round3 = buildPlanEscalationPayload('tc-1', { ...plan, round: 3 }, 3)
    expect(round3.escalation.plan?.round).toBe(3)
  })

  it('escalation.id 确定性：同 toolCallId+planHash+round 同 id（resume 重放幂等——resolveApproval 按 id 校验）', () => {
    const spec = validSpecDoc()
    const plan = buildExperimentPlan(REQUEST, spec)
    const a = buildPlanEscalationPayload('tc-1', plan, 2)
    const b = buildPlanEscalationPayload('tc-1', plan, 2)
    expect(a.escalation.id).toBe(b.escalation.id)
    expect(a.escalation.id).toMatch(/^[0-9a-f-]{36}$/)
    // round 漂移 → id 漂移（第 2/3 轮是新审批）。
    expect(buildPlanEscalationPayload('tc-1', plan, 3).escalation.id).not.toBe(a.escalation.id)
  })
})

describe('W4 人审审计行（853 §5.2：tool_approval_logs 专值 + 引用快照 + round 关联）', () => {
  it('审计行：layer=human / decision 二值 / toolName=experiment_plan / toolCall 快照不存全文', () => {
    const spec = validSpecDoc()
    const plan = buildExperimentPlan(REQUEST, spec)
    const allow = planApprovalAuditRow(plan, 'allow', '附言：注意 GPU 预算', 1)
    expect(allow.layer).toBe('human')
    expect(allow.decision).toBe('allow')
    expect(allow.toolName).toBe('experiment_plan')
    expect(allow.reason).toBe('附言：注意 GPU 预算')
    const snapshot = JSON.parse(allow.toolCall) as Record<string, unknown>
    expect(snapshot.planHash).toBe(planHashOf(spec.content))
    expect(snapshot.planRef).toBe(plan.specRef)
    expect(snapshot.round).toBe(1)
    expect(JSON.stringify(snapshot)).not.toContain(spec.content.slice(0, 40)) // 不存全文

    const deny = planApprovalAuditRow(plan, 'deny', '样本量不足', 2)
    expect(deny.decision).toBe('deny')
    expect(JSON.parse(deny.toolCall).round).toBe(2)
  })

  it('3 轮修订 = 3 行 round 关联（round ∈ [1, PLAN_REVIEW_MAX_ROUNDS]）', () => {
    expect(PLAN_REVIEW_MAX_ROUNDS).toBe(3)
    const spec = validSpecDoc()
    const plan = buildExperimentPlan(REQUEST, spec)
    for (const round of [1, 2, 3] as const) {
      expect(JSON.parse(planApprovalAuditRow(plan, 'deny', 'r', round).toolCall).round).toBe(round)
    }
  })
})

describe('fnv1aHex（载荷 id/hash 共用原语）', () => {
  it('FNV-1a 64-bit hex：确定、分布（相近输入哈希不近）', () => {
    expect(fnv1aHex('a')).toBe(fnv1aHex('a'))
    expect(fnv1aHex('a')).not.toBe(fnv1aHex('b'))
    expect(fnv1aHex('spec-1')).toMatch(/^[0-9a-f]{16}$/)
  })
})
