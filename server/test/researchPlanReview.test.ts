// #912 S3+边界：W4 方案人审循环（853 §5.1）——interrupt 挂起/恢复驱动的修订轮次循环。
// 缝 = 注入的 interrupt 函数（fake 队列消费 resume 值——不起真图，interrupt 载荷边界断言
// 归 experimentPlan.test；本文件锁循环行为：轮次推进 / 3 轮终局 / 审计行序列 / 修订输入回传 /
// resume 无法解析 fail-closed deny）。
import { describe, expect, it } from 'vitest'
import { runPlanReviewLoop, parsePlanDecision } from '../../plugins/research/planReview'
import { buildExperimentPlan, planApprovalAuditRow, type PlanInterruptPayload } from '../../plugins/research/experimentPlan'
import { PLAN_REVIEW_MAX_ROUNDS } from '../../plugins/research/values'
import { validSpecDoc } from './researchFixtures'

const REQUEST = { workflow: 'experiment', question: '验证能量分数判据' } as const

interface FakeHarness {
  readonly decisions: { type: 'approve' | 'reject'; message?: string }[]
  readonly payloads: PlanInterruptPayload[]
  readonly auditRows: ReturnType<typeof planApprovalAuditRow>[]
  readonly revisionReasons: (string | undefined)[]
}

function harness(decisions: { type: 'approve' | 'reject'; message?: string }[]) {
  const h: FakeHarness = { decisions, payloads: [], auditRows: [], revisionReasons: [] }
  return h
}

const run = async (h: FakeHarness, buildPlanImpl?: (revision: string | undefined, round: number) => ReturnType<typeof buildExperimentPlan>) => {
  const interrupt = (payload: PlanInterruptPayload) => {
    h.payloads.push(payload)
    const d = h.decisions[h.payloads.length - 1]!
    // fake 队列全当前轮（historical=false）——历史轮语义由专例锁定。
    return { value: { decisions: [d] }, historical: false }
  }
  let builds = 0
  return {
    result: await runPlanReviewLoop({
      toolCallId: 'tc-1',
      buildPlan: async (revisionReason: string | undefined, _round: number) => {
        builds++
        h.revisionReasons.push(revisionReason)
        if (buildPlanImpl) return buildPlanImpl(revisionReason, _round)
        return buildExperimentPlan(REQUEST, validSpecDoc())
      },
      hooks: {
        interrupt,
        recordAudit: (row) => {
          h.auditRows.push(row)
        },
      },
    }),
    builds: () => builds,
  }
}

describe('W4 planReview 循环（853 §5.1：approve 附言续执行 / deny 回修订 / 3 轮终局）', () => {
  it('首轮 approve：buildPlan 一次（无修订输入）、interrupt 一次、allow 审计一行、返回附言', async () => {
    const h = harness([{ type: 'approve', message: '注意 GPU 预算' }])
    const { result, builds } = await run(h)

    expect(result.outcome).toBe('approved')
    if (result.outcome === 'approved') expect(result.note).toBe('注意 GPU 预算')
    expect(builds()).toBe(1)
    expect(h.revisionReasons).toEqual([undefined])
    expect(h.payloads).toHaveLength(1)
    expect(h.payloads[0]!.escalation.plan!.round).toBe(1)
    expect(h.auditRows.map((r) => [r.decision, JSON.parse(r.toolCall).round])).toEqual([['allow', 1]])
  })

  it('deny → 修订（回传用户理由）→ approve：两轮各一行审计（round 关联）', async () => {
    const h = harness([{ type: 'reject', message: '样本量不足' }, { type: 'approve' }])
    const { result, builds } = await run(h)

    expect(result.outcome).toBe('approved')
    expect(builds()).toBe(2)
    // 修订模式输入 = 上轮 spec + 用户理由（reason 透传 buildPlan 第二参）。
    expect(h.revisionReasons).toEqual([undefined, '样本量不足'])
    expect(h.payloads.map((p) => p.escalation.plan!.round)).toEqual([1, 2])
    expect(h.auditRows.map((r) => [r.decision, JSON.parse(r.toolCall).round])).toEqual([
      ['deny', 1],
      ['allow', 2],
    ])
    expect(h.auditRows[0]!.reason).toBe('样本量不足')
  })

  it('3 连 deny → plan_review_exhausted 终局（run completed 非 failed 语义）：3 行 deny 审计 round 1/2/3', async () => {
    const h = harness([
      { type: 'reject', message: 'r1' },
      { type: 'reject', message: 'r2' },
      { type: 'reject', message: 'r3 理由' },
    ])
    const { result, builds } = await run(h)

    expect(result.outcome).toBe('exhausted')
    if (result.outcome === 'exhausted') expect(result.lastReason).toBe('r3 理由')
    expect(builds()).toBe(PLAN_REVIEW_MAX_ROUNDS)
    expect(h.payloads.map((p) => p.escalation.plan!.round)).toEqual([1, 2, 3])
    expect(h.auditRows.map((r) => [r.decision, JSON.parse(r.toolCall).round])).toEqual([
      ['deny', 1],
      ['deny', 2],
      ['deny', 3],
    ])
  })

  it('deny 无附言：修订照常推进（lastReason 回退「未说明理由」——修订 prompt 不空悬）', async () => {
    const h = harness([{ type: 'reject' }, { type: 'approve' }])
    const { result } = await run(h)
    expect(result.outcome).toBe('approved')
    expect(h.revisionReasons[1]).toBe('未说明理由')
  })

  it('修订重生成失败（buildPlan throw）→ 异常透传（该调用 fail 语义，非终局吞掉）', async () => {
    const h = harness([{ type: 'reject', message: 'r1' }, { type: 'approve' }])
    await expect(
      run(h, (revision) => {
        if (revision !== undefined) throw new Error('design 修订生成重试耗尽（2 次）：schema 拒')
        return buildExperimentPlan(REQUEST, validSpecDoc())
      }),
    ).rejects.toThrow('design 修订生成重试耗尽')
  })
})

describe('parsePlanDecision（resume 回执解析——funnel parseResumeDecisions 同语义）', () => {
  it('approve/reject 二值 + message 透传', () => {
    expect(parsePlanDecision({ decisions: [{ type: 'approve', message: 'm' }] })).toEqual({ type: 'approve', message: 'm' })
    expect(parsePlanDecision({ decisions: [{ type: 'reject', message: '理由' }] })).toEqual({ type: 'deny', message: '理由' })
  })

  it('回执缺失/畸形 → fail-closed deny（审批通道不容含糊——同 funnel 语义）', () => {
    expect(parsePlanDecision(undefined).type).toBe('deny')
    expect(parsePlanDecision({}).type).toBe('deny')
    expect(parsePlanDecision({ decisions: [] }).type).toBe('deny')
    expect(parsePlanDecision({ decisions: [{ type: 'bogus' }] }).type).toBe('deny')
    expect(parsePlanDecision({ decisions: [{ type: 'reject', message: '  ' }] }).message).toBeUndefined()
  })
})


describe('historical 判别（#912 review 修复：多轮 resume 重放「3 轮 = 3 行」不破）', () => {
  it('历史轮（historical=true）跳过审计；当前轮落行', async () => {
    const auditRows: unknown[] = []
    const payloads: PlanInterruptPayload[] = []
    // 模拟重放：第 1 次 interrupt 消费历史值（historical=true），第 2 次当前轮。
    const seq: boolean[] = [true, false]
    let n = 0
    const result = await runPlanReviewLoop({
      toolCallId: 'tc-h',
      buildPlan: async () => buildExperimentPlan({ question: 'Q' }, validSpecDoc()),
      hooks: {
        interrupt: (payload) => {
          payloads.push(payload)
          return {
            value: { decisions: [{ type: n === 0 ? 'reject' : 'approve', message: `d${n}` }] },
            historical: seq[n++]!,
          }
        },
        recordAudit: (row) => {
          auditRows.push(row)
        },
      },
    })
    expect(result.outcome).toBe('approved')
    // 历史轮（deny d0）跳过；当前轮（approve）落 1 行——重放不重复写历史审计。
    expect(auditRows).toHaveLength(1)
    expect((auditRows[0] as { decision: string }).decision).toBe('allow')
  })

  it('历史轮出现 approve → fail-fast（队列语义异常：approve 应为终局轮）', async () => {
    await expect(
      runPlanReviewLoop({
        toolCallId: 'tc-h2',
        buildPlan: async () => buildExperimentPlan({ question: 'Q' }, validSpecDoc()),
        hooks: {
          interrupt: () => ({ value: { decisions: [{ type: 'approve' }] }, historical: true }),
          recordAudit: () => {},
        },
      }),
    ).rejects.toThrow('历史轮出现 approve')
  })

  it('exhausted 终局带 planRef（spec 停留 lab 的引用面）', async () => {
    const result = await runPlanReviewLoop({
      toolCallId: 'tc-h3',
      buildPlan: async (_revision, round) => buildExperimentPlan({ question: 'Q', source_paths: ['critics/x.md'] }, validSpecDoc(), round),
      hooks: {
        interrupt: () => ({ value: { decisions: [{ type: 'reject', message: 'r' }] }, historical: false }),
        recordAudit: () => {},
      },
    })
    expect(result.outcome).toBe('exhausted')
    if (result.outcome === 'exhausted') {
      expect(result.planRef).toMatch(/^\/lab\/specs\/[0-9a-f]+\/r3\/spec\.md$/)
    }
  })
})
