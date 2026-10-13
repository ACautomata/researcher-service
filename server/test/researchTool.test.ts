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
import { SOURCE_PATHS_V1_MAX } from '../../plugins/research/values'
import { createSlotLlm, createWikiFake, paperPageBody, PAPER_PATH, validCriticDoc, validExtractDoc } from './researchFixtures'

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
  extra: { wiki?: PluginToolContext['wiki']; docs?: PluginToolContext['docs'] } = {},
) => {
  const events: Array<{ event: string; detail: Record<string, unknown> }> = []
  const audit: PluginAuditPort = { emitPluginRun: (e) => events.push({ event: e.event, detail: e.detail as Record<string, unknown> }) }
  // 缺省 stub wiki/docs（ctx 六件校验要求装配完整；不消费的用例不触达内部方法）。
  const stubWiki: PluginToolContext['wiki'] = extra.wiki ?? {
    search: vi.fn(async () => ({ ok: true, data: { results: [] } })),
    readPage: vi.fn(async () => ({ ok: false, error: { code: 'not_found', message: 'stub' } })),
    createPage: vi.fn(async () => ({ ok: true, data: { created: true } })),
  } as unknown as PluginToolContext['wiki']
  const stubDocs: PluginToolContext['docs'] = extra.docs ?? {
    extractPdfText: vi.fn(async () => ({ ok: true, data: { pages: [] } })),
  } as unknown as PluginToolContext['docs']
  const ctx: PluginToolContext = {
    config,
    logger: { info: () => {}, warn: () => {} },
    run: { ownerId: 'o1', sessionId: 's1', runId: 'r1' },
    llm,
    audit,
    wiki: stubWiki,
    docs: stubDocs,
  }
  return { ctx, events }
}

const execOf = (ctx: PluginToolContext, signal = new AbortController().signal): PluginToolExec => ({
  signal,
  onUpdate: vi.fn(),
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
    expect(SOURCE_PATHS_V1_MAX).toBe(1)
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

  it('branch 面（占位流程 hypothesize）：content = summary；details = {workflow, status, artifactPages:[]}；audit created→completed', async () => {
    const { ctx, events } = baseCtx(verdictLlm({ label: 'hypothesize', confidence: 0.9 }))
    const result = await executeResearchWorkflow('t2', { topic: '想法' }, execOf(ctx))

    expect(result.content[0]?.type).toBe('text')
    expect((result.content[0] as { text: string }).text).toContain('hypothesize')
    const details = result.details as ResearchRunDetails
    expect(details.status).toBe('completed')
    expect(details.workflow).toBe('hypothesize')
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

  it('seed 透传：命令面带 workflow → 分类器零调用（generateStructured 不做分类）', async () => {
    const llm = discoverCtxLlm()
    const { ctx } = baseCtx(llm, {}, { wiki: discoverWiki() })
    await executeResearchWorkflow('t4', { workflow: 'hypothesize', topic: 'x' }, execOf(ctx))
    // hypothesize 占位零 llm 消费——generateStructured 零调用即分类器未跑
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

  it('stage 上报：流程内节点冒泡带 workflow 域字段（discover 端到端）', async () => {
    const { ctx } = baseCtx(discoverCtxLlm(), {}, { wiki: discoverWiki() })
    const exec = execOf(ctx)
    await executeResearchWorkflow('t9', { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] }, exec)
    expect(exec.onUpdate).toHaveBeenCalledWith({ stage: 'load', workflow: 'discover' })
    expect(exec.onUpdate).toHaveBeenCalledWith({ stage: 'critic', workflow: 'discover' })
  })
})
