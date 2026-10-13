// #909 S3：research_workflow 工具 execute + 4 命令 handler（{execute} outcome 直达面，
// figure 先例同构）。图内行为（分类/路由/clarify）已在 researchGraph.test 锁，流程图行为
// 在 researchIngest/researchDiscover.test 锁——本文件锁工具边界：命令参数映射、ctx 六件
// 校验、audit 三态、content/details 形状、RESEARCH_MODEL pin、分支级 clarify 出口。
import { describe, expect, it, vi } from 'vitest'
import {
  RESEARCH_TOOL_NAME,
  INPUT_TEXT_MAX,
  ingestCommandHandler,
  discoverCommandHandler,
  hypothesizeCommandHandler,
  experimentCommandHandler,
  executeResearchWorkflow,
  type ResearchRunDetails,
} from '../../plugins/research/server'
import type { PluginAuditPort, PluginLlmPort, PluginToolContext, PluginToolExec } from '../src/plugins/api'
import { PluginLlmStructuredError } from '../src/plugins/api'
import {
  createLabFake,
  createSlotLlm,
  createWikiFake,
  paperPageBody,
  PAPER_PATH,
  CRITIC_PATH,
  validCriticDoc,
  validCriticPage,
  validExtractDoc,
  validIdeaCard,
} from './researchFixtures'

// discover 端到端最小 fake 产物（走通全链的最小合法形状——H1/机读标签/候选面齐备）。
const discoverFixtures = () => ({
  extract: validExtractDoc(),
  critic: validCriticDoc([
    { question: 'Q1', priority: 'high' as const, evidence: [`${PAPER_PATH}#1 Citation`] },
    { question: 'Q2', priority: 'low' as const, evidence: [] },
  ]),
})

const baseCtx = (
  llm: PluginToolContext['llm'],
  config: Readonly<Record<string, string>> = {},
  extra: { wiki?: PluginToolContext['wiki']; docs?: PluginToolContext['docs']; lab?: PluginToolContext['lab'] } = {},
) => {
  const events: Array<{ event: string; detail: Record<string, unknown> }> = []
  const approvalRows: unknown[] = []
  const audit: PluginAuditPort = {
    emitPluginRun: (e) => events.push({ event: e.event, detail: e.detail as Record<string, unknown> }),
    recordToolApproval: async (row) => {
      approvalRows.push(row)
      return true
    },
  }
  // 缺省 stub wiki/docs/lab（ctx 七件校验要求装配完整；不消费的用例不触达内部方法）。
  const stubWiki: PluginToolContext['wiki'] = extra.wiki ?? {
    search: vi.fn(async () => ({ ok: true, data: { results: [] } })),
    readPage: vi.fn(async () => ({ ok: false, error: { code: 'not_found', message: 'stub' } })),
    createPage: vi.fn(async () => ({ ok: true, data: { created: true } })),
  } as unknown as PluginToolContext['wiki']
  const stubDocs: PluginToolContext['docs'] = extra.docs ?? {
    extractPdfText: vi.fn(async () => ({ ok: true, data: { pages: [] } })),
  } as unknown as PluginToolContext['docs']
  const stubLab: PluginToolContext['lab'] = extra.lab ?? {
    read: vi.fn(async () => ({ ok: false as const, error: { code: 'not_found' as const, message: 'stub' } })),
    write: vi.fn(async () => ({ ok: true as const, data: { written: true as const } })),
  } as unknown as PluginToolContext['lab']
  const ctx: PluginToolContext = {
    config,
    logger: { info: () => {}, warn: () => {} },
    run: { ownerId: 'o1', sessionId: 's1', runId: 'r1' },
    llm,
    audit,
    wiki: stubWiki,
    docs: stubDocs,
    lab: stubLab,
  }
  return { ctx, events, approvalRows, audit }
}

const execOf = (
  ctx: PluginToolContext,
  signal = new AbortController().signal,
  interrupt?: (value: unknown) => unknown,
): PluginToolExec => ({
  signal,
  onUpdate: vi.fn(),
  // fake 全当前轮（historical=false）——历史轮语义归 researchPlanReview.test 专锁。
  ...(interrupt !== undefined ? { interrupt: (v: unknown) => ({ value: interrupt(v), historical: false }) } : {}),
  ctx,
})

const verdictLlm = (verdict: unknown): PluginLlmPort =>
  ({
    generateMultimodal: vi.fn(async () => ({ text: '' })),
    generateStructured: vi.fn(async () => verdict),
  }) as unknown as PluginLlmPort

// discover 端到端 fake ctx（四件 ctx + slot 判定 llm fake——AC「图 invoke 面 fake ctx 测试」
// 的工具边界形态）：seed discover → 真图全链（openwiki 保真 wiki fake）→ completed。
const discoverCtxLlm = (): PluginLlmPort => {
  const fixtures = discoverFixtures()
  return createSlotLlm({ extract: () => fixtures.extract, critic: () => fixtures.critic })
}

const discoverWiki = (): PluginToolContext['wiki'] => createWikiFake({ [PAPER_PATH]: paperPageBody() }).wiki as unknown as PluginToolContext['wiki']

describe('4 命令 handler（853 §1.1：{execute} 直达，input 槽位 + workflow 显式值）', () => {
  it('/ingest：单篇路径 → source_paths 数组 + workflow=ingest', async () => {
    const outcome = await ingestCommandHandler('/lab/uploads/a.pdf')
    expect(outcome).toEqual({
      execute: { tool: RESEARCH_TOOL_NAME, args: { source_paths: ['/lab/uploads/a.pdf'], workflow: 'ingest' } },
    })
  })

  it('/ingest：多篇 → V1 单篇即时 fail（命令面与 capture 同口径，S8/#24）', async () => {
    await expect(ingestCommandHandler('/lab/uploads/a.pdf /lab/uploads/b.pdf')).rejects.toThrow(/单篇/)
  })

  it('/discover：纯问题 → question 槽位；含 papers/*.md token → 剥离为 source_paths（Spec#26）', async () => {
    expect(await discoverCommandHandler('这篇论文有哪些弱点')).toEqual({
      execute: { tool: RESEARCH_TOOL_NAME, args: { question: '这篇论文有哪些弱点', workflow: 'discover' } },
    })
    expect(await discoverCommandHandler('找问题 papers/robust.md')).toEqual({
      execute: { tool: RESEARCH_TOOL_NAME, args: { question: '找问题', source_paths: ['papers/robust.md'], workflow: 'discover' } },
    })
    expect(await discoverCommandHandler('papers/robust.md')).toEqual({
      execute: { tool: RESEARCH_TOOL_NAME, args: { source_paths: ['papers/robust.md'], workflow: 'discover' } },
    })
  })

  it('/hypothesize /experiment：文本 → topic/question 槽位 + workflow', async () => {
    expect(await hypothesizeCommandHandler('扩散模型加速')).toEqual({
      execute: { tool: RESEARCH_TOOL_NAME, args: { topic: '扩散模型加速', workflow: 'hypothesize' } },
    })
    expect(await experimentCommandHandler('验证 batch size 对收敛的影响')).toEqual({
      execute: { tool: RESEARCH_TOOL_NAME, args: { question: '验证 batch size 对收敛的影响', workflow: 'experiment' } },
    })
  })

  it('空 args → 用法提示 fail（REST 面即时反馈，figure 先例双写形态）', async () => {
    await expect(ingestCommandHandler('')).rejects.toThrow(/用法/)
    await expect(discoverCommandHandler('  ')).rejects.toThrow(/用法/)
  })

  it('超长 args → fail', async () => {
    await expect(discoverCommandHandler('x'.repeat(INPUT_TEXT_MAX + 1))).rejects.toThrow(/超长/)
  })
})

describe('research_workflow execute（工具边界）', () => {
  it('ctx 缺 llm/audit/run/wiki/docs 任一件 → 明确报错不静默降级', async () => {
    const partial = { config: {}, logger: { info: () => {}, warn: () => {} } } as PluginToolContext
    await expect(executeResearchWorkflow('t1', { question: 'x' }, execOf(partial))).rejects.toThrow(/runner-assembled|missing/)
  })

  it('branch 面（hypothesize 真图端到端，#911）：idea-card artifactPages + audit created→completed', async () => {
    const llm = createSlotLlm({ bucket: (prompt) => ({ cards: /你的机会桶：gap/.test(prompt) ? [validIdeaCard()] : [] }) })
    const { ctx, events } = baseCtx(llm, {}, { wiki: createWikiFake({ [PAPER_PATH]: paperPageBody() }).wiki })
    const result = await executeResearchWorkflow(
      't2',
      { workflow: 'hypothesize', topic: 'OOD 检测的新假说', source_paths: [PAPER_PATH], buckets: ['metric'] },
      execOf(ctx),
    )

    const details = result.details as ResearchRunDetails
    expect(details.status).toBe('completed')
    expect(details.workflow).toBe('hypothesize')
    expect(details.artifactPages).toEqual([{ path: 'idea-cards/基于能量分数的-ood-判据改进.md', title: '基于能量分数的 OOD 判据改进' }])
    expect((result.content[0] as { text: string }).text).toContain('idea-cards/')
    expect(events.map((e) => e.event)).toEqual(['created', 'completed'])
    // 数据槽位落 created 审计 detail（source_paths + opt-in buckets 档位）。
    expect(events[0]!.detail.source_paths).toEqual([PAPER_PATH])
    expect(events[0]!.detail.buckets).toEqual(['metric'])
  })

  it('branch 面（experiment 命令直达 → clarify 引导 NL，#912）：details = {workflow, status:clarify}', async () => {
    const { ctx, events } = baseCtx(verdictLlm({ label: 'experiment', confidence: 0.9 }))
    // execOf 不注入 interrupt（无图上下文——{execute} 命令直达形态）→ W4 人审不可用的
    // clarify 引导（无条件人审不破：命令路径不进方案生成）。
    const result = await executeResearchWorkflow('t2c', { question: '想法' }, execOf(ctx))

    expect(result.content[0]?.type).toBe('text')
    expect((result.content[0] as { text: string }).text).toContain('自然语言')
    const details = result.details as ResearchRunDetails
    expect(details.status).toBe('clarify')
    expect(details.workflow).toBe('experiment')
    expect(details.artifactPages).toEqual([])
    expect(events.map((e) => e.event)).toEqual(['created', 'completed'])
  })

  it('branch 面（discover 真图端到端，四件 ctx fake）：artifactPages = critic 页；流程节点 llm 零分类调用', async () => {
    const { ctx, events } = baseCtx(discoverCtxLlm(), {}, { wiki: discoverWiki() })
    const result = await executeResearchWorkflow(
      't2b',
      { workflow: 'discover', question: '找问题', source_paths: [PAPER_PATH] },
      execOf(ctx),
    )

    const details = result.details as ResearchRunDetails
    expect(details.status).toBe('completed')
    expect(details.workflow).toBe('discover')
    expect(details.artifactPages).toEqual([{ path: 'critics/robust-out-of-distribution-detection.md', title: '某论文审稿式问题分析' }])
    expect((result.content[0] as { text: string }).text.length).toBeGreaterThan(0)
    expect(events.map((e) => e.event)).toEqual(['created', 'completed'])
    // completed 审计带 artifactPages（outputText 可检索产物清单）
    expect(events[1]!.detail.artifactPages).toEqual(details.artifactPages)
  })

  it('clarify 面（none 拒识）：content = clarify Result JSON；details.status=clarify；audit completed', async () => {
    const { ctx, events } = baseCtx(verdictLlm({ label: 'none', confidence: 0.9 }))
    const result = await executeResearchWorkflow('t3', { question: '今天天气' }, execOf(ctx))

    const text = (result.content[0] as { text: string }).text
    const parsed = JSON.parse(text) as { status: string; candidates: unknown[]; question: string }
    expect(parsed.status).toBe('clarify')
    expect(parsed.candidates).toEqual([])
    expect(parsed.question.length).toBeGreaterThan(0)
    const details = result.details as ResearchRunDetails
    expect(details.status).toBe('clarify')
    expect(details.clarify?.candidates).toEqual([])
    expect(events.map((e) => e.event)).toEqual(['created', 'completed'])
  })

  it('分支级 clarify（W2 论文页缺失 → 提示先 ingest）：details.status=clarify 带 workflow 语境', async () => {
    const { ctx } = baseCtx(discoverCtxLlm(), {}, { wiki: { search: async () => ({ ok: true, data: { results: [] } }) } as unknown as PluginToolContext['wiki'] })
    const result = await executeResearchWorkflow('t3b', { workflow: 'discover', question: '找不到的论文' }, execOf(ctx))

    const details = result.details as ResearchRunDetails
    expect(details.status).toBe('clarify')
    expect(details.workflow).toBe('discover')
    expect(details.clarify?.question).toContain('ingest')
    expect(details.artifactPages).toEqual([])
  })

  it('分支级 clarify（W3 证据不足 → 不生成泛化 idea，#911）：details 带 workflow 语境', async () => {
    const { ctx } = baseCtx(createSlotLlm({})) // 零 LLM 消耗路径——stub wiki 检索零命中
    const result = await executeResearchWorkflow('t3c', { workflow: 'hypothesize', topic: '完全没有材料的主题' }, execOf(ctx))

    const details = result.details as ResearchRunDetails
    expect(details.status).toBe('clarify')
    expect(details.workflow).toBe('hypothesize')
    expect(details.clarify?.question).toContain('证据不足')
    expect(details.artifactPages).toEqual([])
  })

  it('seed 透传：命令面带 workflow → 分类器零调用（W3 证据不足路径 brief/bucket 零 LLM 消耗）', async () => {
    const llm = discoverCtxLlm()
    // 零命中检索 stub：证据不足先于 brief 的 clarify——generateStructured 零调用即分类器未跑。
    const { ctx } = baseCtx(llm, {}, { wiki: { search: async () => ({ ok: true, data: { results: [] } }) } as unknown as PluginToolContext['wiki'] })
    await executeResearchWorkflow('t4', { workflow: 'hypothesize', topic: 'x' }, execOf(ctx))
    expect(llm.generateStructured).not.toHaveBeenCalled()
  })

  it('RESEARCH_MODEL pin：流程节点 generateStructured 带 model（discover 端到端断言）', async () => {
    const llm = discoverCtxLlm()
    const { ctx } = baseCtx(llm, { RESEARCH_MODEL: 'MiniMax-M3' }, { wiki: discoverWiki() })
    await executeResearchWorkflow('t5b', { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] }, execOf(ctx))
    expect(llm.generateStructured).toHaveBeenCalledWith(expect.objectContaining({ model: 'MiniMax-M3' }))
  })

  it('LLM 解析失败（双保险耗尽）→ audit failed + throw 透传', async () => {
    const llm = {
      generateStructured: vi.fn(async () => {
        throw new PluginLlmStructuredError('结构化输出未通过 schema 校验', 'label: invalid')
      }),
    } as unknown as PluginLlmPort
    const { ctx, events } = baseCtx(llm)
    await expect(executeResearchWorkflow('t6', { question: 'x' }, execOf(ctx))).rejects.toThrow(PluginLlmStructuredError)
    expect(events.map((e) => e.event)).toEqual(['created', 'failed'])
    expect(events[1]?.detail.reason).toBeTruthy()
  })

  it('run aborted → audit aborted（by=user）', async () => {
    const controller = new AbortController()
    const llm = {
      generateStructured: vi.fn(async () => {
        controller.abort()
        throw new Error('aborted')
      }),
    } as unknown as PluginLlmPort
    const { ctx, events } = baseCtx(llm)
    await expect(executeResearchWorkflow('t7', { question: 'x' }, execOf(ctx, controller.signal))).rejects.toThrow(/aborted/)
    expect(events.map((e) => e.event)).toEqual(['created', 'aborted'])
  })

  it('stage 上报经 onUpdate（SSE 翻译面入口）：入口面无域字段', async () => {
    const { ctx } = baseCtx(verdictLlm({ label: 'hypothesize', confidence: 0.9 }))
    const exec = execOf(ctx)
    await executeResearchWorkflow('t8', { topic: 'x' }, exec)
    expect(exec.onUpdate).toHaveBeenCalledWith({ stage: 'classify' })
    expect(exec.onUpdate).toHaveBeenCalledWith({ stage: 'hypothesize' })
  })

  it('stage 上报：流程内节点冒泡带 workflow 域字段（discover + hypothesize 端到端）', async () => {
    const { ctx } = baseCtx(discoverCtxLlm(), {}, { wiki: discoverWiki() })
    const exec = execOf(ctx)
    await executeResearchWorkflow('t9', { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] }, exec)
    expect(exec.onUpdate).toHaveBeenCalledWith({ stage: 'load', workflow: 'discover' })
    expect(exec.onUpdate).toHaveBeenCalledWith({ stage: 'critic', workflow: 'discover' })

    const hypoLlm = createSlotLlm({ bucket: (prompt) => ({ cards: /你的机会桶：gap/.test(prompt) ? [validIdeaCard()] : [] }) })
    const { ctx: hypoCtx } = baseCtx(hypoLlm, {}, { wiki: createWikiFake({ [PAPER_PATH]: paperPageBody() }).wiki })
    const hypoExec = execOf(hypoCtx)
    await executeResearchWorkflow(
      't9b',
      { workflow: 'hypothesize', topic: 'OOD 检测的新假说', source_paths: [PAPER_PATH] },
      hypoExec,
    )
    expect(hypoExec.onUpdate).toHaveBeenCalledWith({ stage: 'contextPack', workflow: 'hypothesize' })
    expect(hypoExec.onUpdate).toHaveBeenCalledWith({ stage: 'bucket', workflow: 'hypothesize' })
    expect(hypoExec.onUpdate).toHaveBeenCalledWith({ stage: 'dedup', workflow: 'hypothesize' })
    expect(hypoExec.onUpdate).toHaveBeenCalledWith({ stage: 'challenge', workflow: 'hypothesize' })
  })
})


// ---------------------------------------------------------------------------
// W4 experiment 工具边界（#912 · 853 §5.1——interrupt 载荷边界断言：source/plan 形状/round /
// spec 落盘短路；批准续执行段 / 3 轮终局 / 审计行；collect 相位分派）。
// ---------------------------------------------------------------------------

const W4_REQUEST: { workflow: 'experiment'; question: string; source_paths: string[] } = { workflow: 'experiment', question: '验证能量分数判据', source_paths: [CRITIC_PATH] }

// agent 路径 fake：interrupt 队列消费 resume 值（exec.interrupt 注入面——不起真图）。
const w4Ctx = (handlers: Parameters<typeof createSlotLlm>[0] = {}) => {
  const llm = createSlotLlm(handlers)
  const wiki = createWikiFake({ [CRITIC_PATH]: validCriticPage() })
  const lab = createLabFake()
  return { ...baseCtx(llm, {}, { wiki: wiki.wiki, lab: lab.lab }), llm, wiki, lab }
}

describe('W4 experiment 工具边界（#912 · interrupt 载荷边界断言）', () => {
  it('approve：details.status=approved——payload source=experiment-plan + plan{title,summary,text,round=1}；审计 allow 行；content 指引执行段', async () => {
    const { ctx, lab, approvalRows } = w4Ctx()
    const payloads: unknown[] = []
    const exec = execOf(ctx, new AbortController().signal, (value: unknown) => {
      payloads.push(value)
      return { decisions: [{ type: 'approve', message: '注意 GPU 预算' }] }
    })
    const result = await executeResearchWorkflow('w4-1', { ...W4_REQUEST }, exec)

    expect(result.details?.status).toBe('approved')
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('已批准')
    expect(text).toContain('注意 GPU 预算')

    // 载荷边界（#852 契约增量）：kind=tool-approval / source=experiment-plan / plan 块 / actionRequests 空。
    const payload = payloads[0] as { kind: string; escalation: Record<string, unknown>; actionRequests: unknown[] }
    expect(payload.kind).toBe('tool-approval')
    expect(payload.escalation.source).toBe('experiment-plan')
    expect(payload.actionRequests).toEqual([])
    const plan = payload.escalation.plan as { title: string; summary: string; text: string; round: number }
    expect(plan.round).toBe(1)
    expect(plan.title).toContain('实验方案')
    expect(plan.text).toContain('## 1 任务背景') // spec 全文内联

    // 审计行：layer=human / decision=allow / toolName=experiment_plan / round 快照。
    expect(approvalRows).toHaveLength(1)
    const row = approvalRows[0] as { layer: string; decision: string; toolName: string; toolCall: string; reason: string }
    expect(row.layer).toBe('human')
    expect(row.decision).toBe('allow')
    expect(row.toolName).toBe('experiment_plan')
    expect(row.reason).toBe('注意 GPU 预算')
    expect(JSON.parse(row.toolCall).round).toBe(1)

    // spec 落盘短路哨兵在（批准后续 collect 的输入面）。
    expect([...lab.files.keys()].some((k) => k.endsWith('/spec.md'))).toBe(true)
  })

  it('3 连 deny → details.status=plan_review_exhausted：3 行审计 round 1/2/3 关联；payload round 序列 1/2/3', async () => {
    const { ctx, approvalRows } = w4Ctx()
    const rounds: number[] = []
    const reasons = ['r1', 'r2', 'r3 样本量不足']
    let n = 0
    const exec = execOf(ctx, new AbortController().signal, (value: unknown) => {
      const p = value as { escalation: { plan: { round: number } } }
      rounds.push(p.escalation.plan.round)
      return { decisions: [{ type: 'reject', message: reasons[n++] }] }
    })
    const result = await executeResearchWorkflow('w4-2', { ...W4_REQUEST }, exec)

    expect(result.details?.status).toBe('plan_review_exhausted')
    expect(rounds).toEqual([1, 2, 3])
    expect((result.content[0] as { text: string }).text).toContain('r3 样本量不足')
    expect(approvalRows.map((r) => JSON.parse((r as { toolCall: string }).toolCall).round)).toEqual([1, 2, 3])
    expect(approvalRows.map((r) => (r as { decision: string }).decision)).toEqual(['deny', 'deny', 'deny'])

    // 修订轮 LLM 重生成（deny → 回 design 修订）：design 调用 3 次（初次 + 2 轮修订）。
    // （calls 在 w4Ctx 未透出，借 approvalRows 行数与 rounds 序列即可锁定轮次语义。）
  })

  it('deny → 修订 prompt 带上轮 spec + 用户理由（复用 design 节点零新图节点）', async () => {
    const revisionPrompts: string[] = []
    const llm = createSlotLlm({
      design: (prompt) => {
        revisionPrompts.push(prompt)
        return undefined // 走默认合法 design
      },
    })
    const wiki = createWikiFake({ [CRITIC_PATH]: validCriticPage() })
    const lab = createLabFake()
    const { ctx } = baseCtx(llm, {}, { wiki: wiki.wiki, lab: lab.lab })
    let n = 0
    const exec = execOf(ctx, new AbortController().signal, () => ({
      decisions: [{ type: n++ === 0 ? 'reject' : 'approve', message: '补大样本对照' }],
    }))
    await executeResearchWorkflow('w4-3', { ...W4_REQUEST }, exec)
    expect(revisionPrompts.length).toBe(2) // 初次 + 修订轮
    expect(revisionPrompts[1]).toContain('修订模式')
    expect(revisionPrompts[1]).toContain('补大样本对照')
  })

  it('stage 上报：plan-review 在 summary 后（挂起即末态 stage 停 plan-review——853 §6.1）', async () => {
    const { ctx } = w4Ctx()
    const exec = execOf(ctx, new AbortController().signal, () => ({ decisions: [{ type: 'approve' }] }))
    await executeResearchWorkflow('w4-4', { ...W4_REQUEST }, exec)
    const calls = (exec.onUpdate as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { stage: string }).stage)
    expect(calls[calls.length - 1]).toBe('plan-review')
    expect(calls).toContain('summary')
    expect(calls.indexOf('summary')).toBeLessThan(calls.indexOf('plan-review'))
  })

  it('spec 落盘短路：resume 重放（同 execute 再调）零 LLM 重调直达 interrupt', async () => {
    const { ctx, llm } = w4Ctx()
    // 首轮 approve（spec 落盘）→ 第二次 execute 模拟 resume 重放：短路直达 interrupt。
    const exec1 = execOf(ctx, new AbortController().signal, () => ({ decisions: [{ type: 'approve' }] }))
    await executeResearchWorkflow('w4-5a', { ...W4_REQUEST }, exec1)
    const callsAfterFirst = llm.calls.length

    const payloads: unknown[] = []
    const exec2 = execOf(ctx, new AbortController().signal, (value: unknown) => {
      payloads.push(value)
      return { decisions: [{ type: 'approve' }] }
    })
    const result = await executeResearchWorkflow('w4-5b', { ...W4_REQUEST }, exec2)
    expect(result.details?.status).toBe('approved')
    expect(llm.calls.length).toBe(callsAfterFirst) // 零 LLM 重调
    expect(payloads).toHaveLength(1) // 直达 interrupt 点
  })

  it('collect 相位（phase=collect）：调用③ 对账图分派——artifactPages = 实验报告页', async () => {
    const { ctx, lab } = w4Ctx()
    // 先落 spec + 旁车（调用① 的产出面）。
    const exec1 = execOf(ctx, new AbortController().signal, () => ({ decisions: [{ type: 'approve' }] }))
    await executeResearchWorkflow('w4-6a', { ...W4_REQUEST }, exec1)
    const specPath = [...lab.files.keys()].find((k) => k.endsWith('/spec.md'))!
    lab.files.set(`${specPath.slice(0, specPath.lastIndexOf('/'))}/deliverables.json`, JSON.stringify({ deliverables: [], inputPages: [CRITIC_PATH] }))
    lab.files.set('/lab/results/r.json', '{}')

    const llm2 = createSlotLlm({})
    const wiki2 = createWikiFake({ [CRITIC_PATH]: validCriticPage() })
    const lab2 = createLabFake(Object.fromEntries(lab.files))
    const { ctx: ctx2 } = baseCtx(llm2, {}, { wiki: wiki2.wiki, lab: lab2.lab })
    const result = await executeResearchWorkflow('w4-6b', { workflow: 'experiment', phase: 'collect', source_paths: [specPath] }, execOf(ctx2))

    expect(result.details?.status).toBe('completed')
    expect(result.details?.artifactPages[0]?.path).toMatch(/^experiment-reports\//)
    expect((result.content[0] as { text: string }).text).toContain('实验报告已落 wiki')
  })

  it('多轮 resume 重放（deny→deny→approve）：每轮一次真生成（重放全短路零 LLM 重调）+ 审计 3 行 round 关联（#912 review 修复）', async () => {
    const { ctx, llm, approvalRows, lab } = w4Ctx()
    // 首轮：LLM 生成 r1 → 挂审（interrupt 抛——fake 返消费值模拟 resume）。
    const decisions = [
      { type: 'reject', message: 'r1 理由' },
      { type: 'reject', message: 'r2 理由' },
      { type: 'approve', message: '可以了' },
    ]
    let n = 0
    const payloads: { escalation: { plan: { round: number } } }[] = []
    const exec = execOf(ctx, new AbortController().signal, (value: unknown) => {
      payloads.push(value as never)
      return { decisions: [{ type: decisions[n]!.type, message: decisions[n++]!.message }] }
    })
    const result = await executeResearchWorkflow('w4-8', { ...W4_REQUEST }, exec)

    expect(result.details?.status).toBe('approved')
    // 3 轮各一次 interrupt（round 1/2/3），修订轮（round 2/3）的 buildPlan 经短路零 LLM——
    // 全部 LLM 调用 = design 3（每轮一次真生成）+ spec 3 + audit 3；重放不再追加。
    expect(payloads.map((p) => p.escalation.plan.round)).toEqual([1, 2, 3])
    expect(llm.calls.filter((c) => c.slot === 'design')).toHaveLength(3)
    expect(llm.calls.filter((c) => c.slot === 'spec')).toHaveLength(3)
    expect(llm.calls.filter((c) => c.slot === 'audit')).toHaveLength(3)
    // 3 行审计（deny/deny/allow），round 关联 1/2/3——重放不重复落行。
    expect(approvalRows).toHaveLength(3)
    expect(approvalRows.map((r) => (r as { decision: string }).decision)).toEqual(['deny', 'deny', 'allow'])
    expect(approvalRows.map((r) => JSON.parse((r as { toolCall: string }).toolCall).round)).toEqual([1, 2, 3])
    // 每轮 spec 落各自 round 目录（r1/r2/r3 互不覆盖——round 键控内容一致性面）。
    const specKeys = [...lab.files.keys()].filter((k) => k.endsWith('/spec.md')).sort()
    expect(specKeys.map((k) => k.match(/\/r[0-9]\//)?.[0])).toEqual(['/r1/', '/r2/', '/r3/'])
    // 修订轮 design prompt 注入的是上轮 spec（r1 内容进第 2 轮修订 prompt——首轮 spec 文本仍原文可读）。
  })

  it('audit 审计面缺省（recordToolApproval undefined）→ fail-closed throw', async () => {
    const llm = createSlotLlm({})
    const wiki = createWikiFake({ [CRITIC_PATH]: validCriticPage() })
    const lab = createLabFake()
    const { ctx } = baseCtx(llm, {}, { wiki: wiki.wiki, lab: lab.lab })
    const ctxNoApproval = { ...ctx, audit: { emitPluginRun: ctx.audit!.emitPluginRun!.bind(ctx.audit) } as PluginAuditPort }
    const exec = execOf(ctxNoApproval, new AbortController().signal, () => ({ decisions: [{ type: 'approve' }] }))
    await expect(executeResearchWorkflow('w4-7', { ...W4_REQUEST }, exec)).rejects.toThrow(/fail-closed/)
  })
})


// ---------------------------------------------------------------------------
// graphInterruptOf 直测（#912 review 修复 P0-1）：historical 判别按 LangGraph 真实队列
// 语义锁定——真实 interrupt() 跑三分支（历史消费 / nullResume 新值消费 / 挂起 throw），
// scratchpad 形状按 langgraph 1.4.18（interruptCounter -1 起 0 基递增 / resume = 已持久化
// 历史值 / nullResume 待消费新值，消费时 push 进 resume）。历史消费条件 idx < resume.length
// ⇔ 1 基 callIdx <= resume.length——deny→deny→approve 三轮重放下终局恰 3 行审计的判别根。
// ---------------------------------------------------------------------------
import { graphInterruptOf } from '../src/plugins/tools'
import { GraphInterrupt } from '@langchain/langgraph'

const makeScratchpadRuntime = (resume: unknown[], nullResume?: unknown) => {
  const scratchpad: {
    interruptCounter: number
    resume: unknown[]
    nullResume: unknown
    consumeNullResume: () => unknown
  } = {
    interruptCounter: -1,
    resume: [...resume],
    nullResume: nullResume as unknown,
    consumeNullResume: () => {
      const v = scratchpad.nullResume
      scratchpad.nullResume = undefined
      return v
    },
  }
  return {
    runtime: { configurable: { __pregel_checkpointer: {}, __pregel_scratchpad: scratchpad } } as unknown,
    scratchpad,
  }
}

const resumeDecision = (label: string) => ({ decisions: [{ type: 'approve', message: label }] })

describe('graphInterruptOf：historical 判别 = LangGraph 队列语义（P0-1）', () => {
  it('无 checkpointer（configurable 缺 __pregel_checkpointer）→ undefined（命令直达不可挂起）', () => {
    expect(graphInterruptOf({ configurable: {} })).toBeUndefined()
    expect(graphInterruptOf(undefined)).toBeUndefined()
  })

  it('0 历史值：首调消费 nullResume（historical=false）；次调挂起 throw GraphInterrupt', () => {
    const { runtime } = makeScratchpadRuntime([], resumeDecision('v0'))
    const fn = graphInterruptOf(runtime)!
    expect(fn(resumeDecision('p0'))).toEqual({ value: resumeDecision('v0'), historical: false })
    expect(() => fn(resumeDecision('p1'))).toThrow(GraphInterrupt)
  })

  it('2 历史值：前两调 historical=true 依次返回历史值；第三调消费 nullResume（false）；第四调挂起', () => {
    const { runtime, scratchpad } = makeScratchpadRuntime([resumeDecision('h0'), resumeDecision('h1')], resumeDecision('v2'))
    const fn = graphInterruptOf(runtime)!
    expect(fn(resumeDecision('p0'))).toEqual({ value: resumeDecision('h0'), historical: true })
    expect(fn(resumeDecision('p1'))).toEqual({ value: resumeDecision('h1'), historical: true })
    expect(fn(resumeDecision('p2'))).toEqual({ value: resumeDecision('v2'), historical: false })
    expect(() => fn(resumeDecision('p3'))).toThrow(GraphInterrupt)
    // 新值消费时 push 进 resume 队列（历史值持久化面——下次重放本值即历史）。
    expect(scratchpad.resume).toHaveLength(3)
  })

  it('3 历史值无 nullResume：三轮 historical=true 后挂起（deny→deny→deny 终局轮重放形态）', () => {
    const { runtime } = makeScratchpadRuntime([resumeDecision('h0'), resumeDecision('h1'), resumeDecision('h2')])
    const fn = graphInterruptOf(runtime)!
    expect(fn(resumeDecision('p0'))!.historical).toBe(true)
    expect(fn(resumeDecision('p1'))!.historical).toBe(true)
    expect(fn(resumeDecision('p2'))!.historical).toBe(true)
    expect(() => fn(resumeDecision('p3'))).toThrow(GraphInterrupt)
  })
})
