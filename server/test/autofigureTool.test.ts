// AutoFigure 工具包装（#792 · #744 §10 票 4 · S3）：execute 全链——ctx 四件校验、审计
// 五类时序（created → completed/failed/aborted）、figures.create 输入、details/content
// 引用形态（R6 事实同源）、usage 并入、onUpdate 六 stage 上报、面板配置校验。

import { describe, it, expect } from 'vitest'
import {
  executeFigureGenerate,
  assertFigureContext,
  readAutofigureConfig,
  figureCommandHandler,
  ctxLlmAdapter,
  FIGURE_TOOL_NAME,
} from '../../plugins/autofigure/server'
import type { PluginToolContext, PluginToolResult, FigureRunAuditEvent } from '../src/plugins/api'
import { makeFakePorts } from './autofigureFakePorts'

const PANEL_CONFIG: Record<string, string> = {
  AUTOFIGURE_IMAGE_MODEL: 'image-01',
  AUTOFIGURE_IMAGE_API_KEY: 'img-key',
  FAL_KEY: 'fal-key',
  AUTOFIGURE_SVG_MODEL: '',
}

type FakeCtx = PluginToolContext & { auditEvents: FigureRunAuditEvent[]; created: unknown[]; llmReply?: string }

function fakeCtx(overrides: Partial<FakeCtx> = {}): FakeCtx {
  const auditEvents: FigureRunAuditEvent[] = []
  const created: unknown[] = []
  const self: FakeCtx = {
    auditEvents,
    created,
    config: PANEL_CONFIG,
    logger: { info: () => {}, warn: () => {} },
    run: { ownerId: 'u1', sessionId: 'sess-1', runId: 'run-1' },
    figures: {
      create: async (input) => {
        created.push(input)
        return { figureId: `fig-${created.length}` }
      },
    },
    llm: {
      generateMultimodal: async (opts) => {
        void opts
        return { text: self.llmReply ?? 'ok', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }
      },
    },
    audit: { emitFigureRun: (e) => auditEvents.push(e) },
    ...overrides,
  }
  return self
}

function runExecute(ctx: PluginToolContext, signal: AbortSignal = new AbortController().signal, stages: string[] = [], withIcons = true) {
  return executeFigureGenerate(
    'tc-1',
    { method_text: '画一个蛋白质折叠示意图' },
    { signal, onUpdate: (p) => stages.push((p as { stage: string }).stage), ctx },
    {
      compute: (config, c, usage) => {
        void config
        const { ports, sam3 } = makeFakePorts()
        if (withIcons) {
          // SAM3 有命中 → 完整六节点（no_icon_mode 跳过 preparing 是上游保真语义，另测锁定）
          sam3.detectionsByPrompt.set('icon', [{ x1: 0, y1: 0, x2: 2, y2: 2, score: 0.9 }])
        }
        // llm 桥接 ctx.llm（生产 ctxLlmAdapter 同一实现——usage 并入 executeFigureGenerate 的聚合面）
        return { ...ports, llm: ctxLlmAdapter(c as never, usage) }
      },
    },
  )
}

describe('assertFigureContext（ctx 四件校验）', () => {
  it('四件齐全通过；缺件明确报错（点名缺失面）', () => {
    expect(assertFigureContext(fakeCtx()).run!.ownerId).toBe('u1')
    for (const key of ['run', 'figures', 'llm', 'audit'] as const) {
      const broken = fakeCtx()
      delete (broken as unknown as Record<string, unknown>)[key]
      expect(() => assertFigureContext(broken)).toThrow(new RegExp(`missing.*${key}`))
    }
  })
})

describe('readAutofigureConfig（面板配置校验）', () => {
  it('声明键解析；缺生图模型 / 缺 fal key 明确报错', () => {
    expect(readAutofigureConfig(PANEL_CONFIG).imageModel).toBe('image-01')
    expect(() => readAutofigureConfig({})).toThrow(/AUTOFIGURE_IMAGE_MODEL/)
    expect(() => readAutofigureConfig({ AUTOFIGURE_IMAGE_MODEL: 'image-01' })).toThrow(/FAL_KEY/)
  })
})

describe('executeFigureGenerate（唯一执行面）', () => {
  it('happy path：created → 六 stage onUpdate → completed；figures.create 引用形态落库；details/content 同源', async () => {
    const ctx = fakeCtx({ llmReply: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" viewBox="0 0 4 4"><g id="AF01">x</g></svg>' })
    const stages: string[] = []
    const result = (await runExecute(ctx, undefined, stages)) as PluginToolResult<{ figureId: string; state: string; previewReady: boolean }>
    // 六 stage 上报一次（runner 落双面——本侧只管上报）
    expect(stages).toEqual(['generating', 'segmenting', 'preparing', 'templating', 'assembling', 'rendering'])
    // no_icon_mode（SAM 无命中）跳过 preparing——上游保真语义（§3.1「no_icon_mode 下跳过」）
    const noIconStages: string[] = []
    await runExecute(fakeCtx(), new AbortController().signal, noIconStages, false)
    expect(noIconStages).toEqual(['generating', 'segmenting', 'templating', 'assembling', 'rendering'])
    // 审计时序：created → completed（无 failed/aborted）
    expect(ctx.auditEvents.map((e) => e.event)).toEqual(['created', 'completed'])
    expect(ctx.auditEvents[0]!.toolCallId).toBe('tc-1')
    expect((ctx.auditEvents[0]!.detail.methodText as string).startsWith('画一个')).toBe(true)
    // figures.create 输入（#744 §11.1 签名）：methodText/finalSvg/meta/sessionId 溯源
    expect(ctx.created).toHaveLength(1)
    const created = ctx.created[0] as { prompt: string; svg: string; meta: { renderer: string }; sessionId: string }
    expect(created.prompt).toBe('画一个蛋白质折叠示意图')
    expect(created.svg).toContain('<svg')
    expect(created.meta.renderer).toBe('sharp-librsvg')
    expect(created.sessionId).toBe('sess-1')
    // 引用形态：details = {figureId, state, previewReady}；content 携带同源事实（R6）
    expect(result.details).toMatchObject({ figureId: 'fig-1', state: 'completed' })
    expect(typeof result.details!.previewReady).toBe('boolean')
    const contentText = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
    expect(contentText).toContain('figureId=fig-1')
    expect(contentText).toContain('/api/v1/figures/fig-1/svg')
    // usage 并入（嵌套 LLM 调用累计）
    expect(result.usage!.totalTokens).toBeGreaterThan(0)
  })

  it('graph 失败 → failed 审计（稳定 reason）+ 异常上抛', async () => {
    const ctx = fakeCtx()
    await expect(
      executeFigureGenerate(
        'tc-2',
        { method_text: 'x' },
        { signal: new AbortController().signal, ctx },
        {
          compute: () => {
            const { ports, imageGen } = makeFakePorts()
            imageGen.fail = true
            return ports
          },
        },
      ),
    ).rejects.toThrow('image gen failed')
    expect(ctx.auditEvents.map((e) => e.event)).toEqual(['created', 'failed'])
    expect(ctx.auditEvents[1]!.detail.reason).toBe('image gen failed')
    // 失败无产物落库
    expect(ctx.created).toHaveLength(0)
  })

  it('abort → aborted 审计（by=user），无半产物', async () => {
    const ctx = fakeCtx()
    const controller = new AbortController()
    await expect(
      executeFigureGenerate(
        'tc-3',
        { method_text: 'x' },
        { signal: controller.signal, ctx },
        {
          compute: () => {
            const { ports, imageGen } = makeFakePorts()
            // abort 于生图后触发（graph 内 AbortSignal 传播）
            const orig = imageGen.generate.bind(imageGen)
            imageGen.generate = async (p, m) => {
              controller.abort()
              return orig(p, m)
            }
            return ports
          },
        },
      ),
    ).rejects.toThrow()
    expect(ctx.auditEvents.map((e) => e.event)).toEqual(['created', 'aborted'])
    expect(ctx.auditEvents[1]!.detail.by).toBe('user')
    expect(ctx.created).toHaveLength(0)
  })

  it('面板配置缺失 → 明确报错（failed 审计），不静默', async () => {
    const ctx = fakeCtx({ config: {} })
    await expect(
      executeFigureGenerate('tc-4', { method_text: 'x' }, { signal: new AbortController().signal, ctx }),
    ).rejects.toThrow(/AUTOFIGURE_IMAGE_MODEL/)
    expect(ctx.auditEvents.map((e) => e.event)).toEqual(['created', 'failed'])
  })

  it('ctx 四件缺失 → 明确报错（无 created 审计——执行面未启动）', async () => {
    const broken = fakeCtx()
    delete (broken as unknown as Record<string, unknown>).llm
    await expect(
      executeFigureGenerate('tc-5', { method_text: 'x' }, { signal: new AbortController().signal, ctx: broken }),
    ).rejects.toThrow(/missing.*llm/)
    expect(broken.auditEvents).toHaveLength(0)
  })
})

describe('figureCommandHandler（{execute} outcome）', () => {
  it('args → execute outcome 直达同一工具', async () => {
    const outcome = await figureCommandHandler('  画示意图  ')
    expect(outcome.execute.tool).toBe(FIGURE_TOOL_NAME)
    expect(outcome.execute.args.method_text).toBe('画示意图')
  })

  it('空 args / 超长 args 拒绝（80001）', async () => {
    await expect(figureCommandHandler('   ')).rejects.toMatchObject({ code: 80001 })
    await expect(figureCommandHandler('a'.repeat(4001))).rejects.toMatchObject({ code: 80001 })
  })
})
