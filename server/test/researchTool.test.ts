// #909 S3：research_workflow 工具 execute + 4 命令 handler（{execute} outcome 直达面，
// figure 先例同构）。图内行为（分类/路由/clarify）已在 researchGraph.test 锁——本文件锁
// 工具边界：命令参数映射、ctx 六件校验、audit 三态、content/details 形状、RESEARCH_MODEL pin。
import { describe, expect, it, vi } from 'vitest'
import {
  RESEARCH_TOOL_NAME,
  INPUT_TEXT_MAX,
  SOURCE_PATHS_MAX,
  ingestCommandHandler,
  discoverCommandHandler,
  hypothesizeCommandHandler,
  experimentCommandHandler,
  executeResearchWorkflow,
  type ResearchRunDetails,
} from '../../plugins/research/server'
import type { PluginAuditPort, PluginLlmPort, PluginToolContext, PluginToolExec } from '../src/plugins/api'
import { PluginLlmStructuredError } from '../src/plugins/api'

const baseCtx = (llm: PluginToolContext['llm'], config: Readonly<Record<string, string>> = {}) => {
  const events: Array<{ event: string; detail: Record<string, unknown> }> = []
  const audit: PluginAuditPort = { emitPluginRun: (e) => events.push({ event: e.event, detail: e.detail as Record<string, unknown> }) }
  const ctx: PluginToolContext = {
    config,
    logger: { info: () => {}, warn: () => {} },
    run: { ownerId: 'o1', sessionId: 's1', runId: 'r1' },
    llm,
    audit,
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

describe('4 命令 handler（853 §1.1：{execute} 直达，input 槽位 + workflow 显式值）', () => {
  it('/ingest：空格分隔路径 → source_paths 数组 + workflow=ingest', async () => {
    const outcome = await ingestCommandHandler('/lab/uploads/a.pdf /lab/uploads/b.pdf')
    expect(outcome).toEqual({
      execute: { tool: RESEARCH_TOOL_NAME, args: { source_paths: ['/lab/uploads/a.pdf', '/lab/uploads/b.pdf'], workflow: 'ingest' } },
    })
  })

  it('/discover /hypothesize /experiment：文本 → question/topic 槽位 + workflow', async () => {
    expect(await discoverCommandHandler('这篇论文有哪些弱点')).toEqual({
      execute: { tool: RESEARCH_TOOL_NAME, args: { question: '这篇论文有哪些弱点', workflow: 'discover' } },
    })
    expect(await hypothesizeCommandHandler('扩散模型加速')).toEqual({
      execute: { tool: RESEARCH_TOOL_NAME, args: { topic: '扩散模型加速', workflow: 'hypothesize' } },
    })
    expect(await experimentCommandHandler('验证 batch size 对收敛的影响')).toEqual({
      execute: { tool: RESEARCH_TOOL_NAME, args: { question: '验证 batch size 对收敛的影响', workflow: 'experiment' } },
    })
  })

  it('空 args → 用法提示 fail（REST 面即时反馈，figure 先例双写形态）', async () => {
    await expect(ingestCommandHandler('')).rejects.toThrow()
    await expect(discoverCommandHandler('  ')).rejects.toThrow()
  })

  it('超长 args → fail', async () => {
    await expect(discoverCommandHandler('x'.repeat(INPUT_TEXT_MAX + 1))).rejects.toThrow()
  })

  it('/ingest 路径数超上限 → fail', async () => {
    const paths = Array.from({ length: SOURCE_PATHS_MAX + 1 }, (_, i) => `/lab/uploads/f${i}.pdf`).join(' ')
    await expect(ingestCommandHandler(paths)).rejects.toThrow()
  })
})

describe('research_workflow execute（工具边界）', () => {
  it('ctx 缺 llm/audit/run 任一件 → 明确报错不静默降级', async () => {
    const partial = { config: {}, logger: { info: () => {}, warn: () => {} } } as PluginToolContext
    await expect(executeResearchWorkflow('t1', { question: 'x' }, execOf(partial))).rejects.toThrow(/runner-assembled|missing/)
  })

  it('branch 面：content = summary；details = {workflow, status, artifactPages}；audit created→completed', async () => {
    const { ctx, events } = baseCtx(verdictLlm({ label: 'discover', confidence: 0.9 }))
    const result = await executeResearchWorkflow('t2', { question: '找问题' }, execOf(ctx))

    expect(result.content[0]?.type).toBe('text')
    expect(String((result.content[0] as { text: string }).text)).toContain('discover')
    const details = result.details as ResearchRunDetails
    expect(details.status).toBe('completed')
    expect(details.workflow).toBe('discover')
    expect(details.artifactPages).toEqual([])
    expect(events.map((e) => e.event)).toEqual(['created', 'completed'])
  })

  it('clarify 面：content = clarify Result JSON；details.status=clarify；audit completed', async () => {
    const { ctx, events } = baseCtx(verdictLlm({ label: 'none', confidence: 0.9 }))
    const result = await executeResearchWorkflow('t3', { question: '今天天气' }, execOf(ctx))

    const text = String((result.content[0] as { text: string }).text)
    const parsed = JSON.parse(text) as { status: string; candidates: unknown[]; question: string }
    expect(parsed.status).toBe('clarify')
    expect(parsed.candidates).toEqual([])
    expect(parsed.question.length).toBeGreaterThan(0)
    const details = result.details as ResearchRunDetails
    expect(details.status).toBe('clarify')
    expect(details.clarify?.candidates).toEqual([])
    expect(events.map((e) => e.event)).toEqual(['created', 'completed'])
  })

  it('seed 透传：命令面带 workflow → 分类器零调用（generateStructured 零调用）', async () => {
    const llm = verdictLlm({ label: 'ingest', confidence: 0.9 })
    const { ctx } = baseCtx(llm)
    await executeResearchWorkflow('t4', { workflow: 'ingest', source_paths: ['/lab/uploads/a.pdf'] }, execOf(ctx))
    expect(llm.generateStructured).not.toHaveBeenCalled()
  })

  it('RESEARCH_MODEL pin：config 非空 → generateStructured model 参数', async () => {
    const llm = verdictLlm({ label: 'ingest', confidence: 0.9 })
    const { ctx } = baseCtx(llm, { RESEARCH_MODEL: 'MiniMax-M3' })
    await executeResearchWorkflow('t5', { question: 'x' }, execOf(ctx))
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
    await expect(executeResearchWorkflow('t7', { question: 'x' }, execOf(ctx, controller.signal))).rejects.toThrow()
    expect(events.map((e) => e.event)).toEqual(['created', 'aborted'])
  })

  it('stage 上报经 onUpdate（SSE 翻译面入口）', async () => {
    const { ctx } = baseCtx(verdictLlm({ label: 'ingest', confidence: 0.9 }))
    const exec = execOf(ctx)
    await executeResearchWorkflow('t8', { question: 'x' }, exec)
    expect(exec.onUpdate).toHaveBeenCalledWith({ stage: 'classify' })
    expect(exec.onUpdate).toHaveBeenCalledWith({ stage: 'ingest' })
  })
})
