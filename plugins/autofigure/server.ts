// AutoFigure 插件 server 面实现体（#792 · #744 §10 票 4）：figure 工具 execute 包装与
// /figure 命令 handler。manifest.ts 是声明入口，本文件是实现体（#752 §1 自由组织）。
//
// 工具唯一入口（#744 Q10）：agent 自动调用（manifest 注册 → run 启用集过滤进图）与
// /figure 命令 {execute} outcome（直达 executePluginToolRun）两条触发面共用本 execute——
// 不经 agent 自由裁量，AutoFigureView/REST 创建端点不复活。
//
// ctx 四件消费（#744 §11.1）：run 身份（sessionId 溯源）/ figures.create 单写 / llm 回退链
//（回退逻辑封装在核心，本侧只传 model 选用）/ audit 五类审计面。四件缺失（无 runner 装配
// 的调用面）→ 明确报错，不静默降级。
//
// 审计分工（#744 §11.2）：created/completed/failed/aborted 由本侧经 ctx.audit 落（插件
// catch 落 aborted 终态——exec.signal 传播）；stage 变化只经 onUpdate 上报一次，SSE
// figure_run.progress 与 TextTrace figure_run.stage_transitions 双面由 runner 落。

import type {
  PluginLlmContent,
  PluginToolContentBlock,
  PluginToolContext,
  PluginToolResult,
  PluginToolUsage,
} from '../../server/src/plugins/api'
import { fail } from '../../server/src/envelope'
import { CODE } from '../../server/src/codes'
import { truncateAuditMethodText } from '../../server/src/figures/figureAudit'
import { createFigurePipelineGraph } from './pipeline/graph'
import type { FigureComputePorts, FigureLlmPort, LlmCallOptions } from './compute/ports'
import { FalRmbgPort, FalSam3Port } from './compute/fal'
import { MiniMaxImageGenPort } from './compute/imageGen'
import { SharpImageOpsPort, SharpRenderPort } from '../../server/src/plugins/autofigureSharp'

export const FIGURE_TOOL_NAME = 'figure_generate'
export const FIGURE_COMMAND_NAME = 'figure'

// V1 输入仅 method_text，长度上限沿 4000 UTF-16 单元语义（#744 §4.1）。
export const METHOD_TEXT_MAX = 4000

export const figureToolDescription =
  'Generate an editable SVG method figure from a textual method description (AutoFigure pipeline). Returns a figureId referencing the stored figure; render it via GET /api/v1/figures/<figureId>/svg.'

// ---------------------------------------------------------------------------
// ctx 四件校验（#744 §11.1）：缺件 = 无 runner 装配的调用面——明确报错不静默降级。
// ---------------------------------------------------------------------------

export interface FigureToolContext {
  readonly config: Readonly<Record<string, string>>
  readonly run: NonNullable<PluginToolContext['run']>
  readonly figures: NonNullable<PluginToolContext['figures']>
  readonly llm: NonNullable<PluginToolContext['llm']>
  readonly audit: NonNullable<PluginToolContext['audit']>
  readonly logger: PluginToolContext['logger']
}

export function assertFigureContext(ctx: PluginToolContext): FigureToolContext {
  const missing = [
    ...(ctx.run ? [] : ['run']),
    ...(ctx.figures ? [] : ['figures']),
    ...(ctx.llm ? [] : ['llm']),
    ...(ctx.audit ? [] : ['audit']),
  ]
  if (missing.length > 0) {
    throw new Error(`figure tool requires runner-assembled plugin context; missing: ${missing.join(', ')}`)
  }
  return ctx as unknown as FigureToolContext
}

// ---------------------------------------------------------------------------
// 面板级配置（ctx.config = configSchema 声明键的解析值；#744 §6 凭证纪律：env 注入、
// 不落盘、不入日志、不进事件载荷/产物）。导出——出现在导出接口 FigureExecuteDeps/
// buildComputePorts 签名中（外部结构推导面）。
// ---------------------------------------------------------------------------

export interface AutofigureRuntimeConfig {
  readonly imageModel: string
  readonly imageApiKey: string
  readonly imageBaseUrl: string | undefined
  readonly falKey: string
  /** 空 = ctx.llm 默认链 primary（owner provider 回退链首模型）。 */
  readonly svgModel: string
}

export function readAutofigureConfig(config: Readonly<Record<string, string>>): AutofigureRuntimeConfig {
  const cfg: AutofigureRuntimeConfig = {
    imageModel: config.AUTOFIGURE_IMAGE_MODEL ?? '',
    imageApiKey: config.AUTOFIGURE_IMAGE_API_KEY ?? '',
    imageBaseUrl: config.AUTOFIGURE_IMAGE_BASE_URL || undefined,
    falKey: config.FAL_KEY ?? '',
    svgModel: config.AUTOFIGURE_SVG_MODEL ?? '',
  }
  if (cfg.imageModel.trim() === '') throw new Error('AUTOFIGURE_IMAGE_MODEL 未配置：figure 生图需要面板级模型名')
  if (cfg.falKey.trim() === '') throw new Error('FAL_KEY 未配置：figure 云计算（SAM3/RMBG）需要 fal key')
  // 三必填键分工：imageModel/falKey 在此调用面校验；imageApiKey 由 MiniMaxImageGenPort
  // 构造期 fail-fast（凭证构造期校验纪律，与 fal.ts 适配器同型，#744 §6）——两条路径都在
  // 首个云 API 调用前触发，无遗漏窗口。
  return cfg
}

// ---------------------------------------------------------------------------
// 计算面组装：云 API 适配器（面板 env）+ sharp 适配器（server 侧）+ ctx.llm 桥接
//（FigureLlmPort ← ctx.llm，usage 经闭包累计并入工具结果）
// ---------------------------------------------------------------------------

function ctxLlmAdapter(ctx: FigureToolContext, usage: PluginToolUsage[]): FigureLlmPort {
  const call = async (contents: readonly PluginLlmContent[], model: string, opts: LlmCallOptions): Promise<string> => {
    const r = await ctx.llm.generateMultimodal({ contents, model, maxTokens: opts.maxTokens, temperature: opts.temperature })
    if (r.usage) usage.push(r.usage)
    return r.text
  }
  return {
    text: (prompt, model, opts) => call([prompt], model, opts),
    multimodal: (contents, model, opts) => call(contents, model, opts),
  }
}
export { ctxLlmAdapter }

export function buildComputePorts(
  config: AutofigureRuntimeConfig,
  ctx: FigureToolContext,
  usage: PluginToolUsage[],
): FigureComputePorts {
  return {
    imageGen: new MiniMaxImageGenPort({
      apiKey: config.imageApiKey,
      ...(config.imageBaseUrl !== undefined ? { baseUrl: config.imageBaseUrl } : {}),
    }),
    llm: ctxLlmAdapter(ctx, usage),
    sam3: new FalSam3Port({ apiKey: config.falKey }),
    rmbg: new FalRmbgPort({ apiKey: config.falKey }),
    render: new SharpRenderPort(),
    imageOps: new SharpImageOpsPort(),
  }
}

// 失败原因稳定非敏感（#744 §11.2 failed{reason}）：错误消息截断（适配器侧已归一为固定
// 类别消息，不落凭证/响应体）。
function stableReason(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw
}

function mergeUsage(list: readonly PluginToolUsage[]): PluginToolUsage | undefined {
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  let seen = false
  for (const u of list) {
    seen = true
    inputTokens += u.inputTokens ?? 0
    outputTokens += u.outputTokens ?? 0
    totalTokens += u.totalTokens ?? 0
  }
  return seen ? { inputTokens, outputTokens, totalTokens } : undefined
}

// ---------------------------------------------------------------------------
// figure 工具 execute（唯一执行面）
// ---------------------------------------------------------------------------

// details 引用形态（#744 §4.2 Q9 核心）：工具结果 = figureId 引用不内联 SVG（可达 MB 级）；
// SVG 本体经 GET /figures/:id/svg 拉取（渲染层只读 IO，实时回放同一路径）。
export interface FigureResultDetails {
  readonly figureId: string
  readonly state: 'completed'
  readonly previewReady: boolean
}

// compute 注入缝（S3 测试面）：缺省 = 生产适配器组装。manifest 引用不传——签名兼容。
// 签名类型 typeof 单源（Duplicated Code 收口：与 buildComputePorts 字面同三元组是
// 第 4 轮发现，声明位置在其后故 typeof 可引）。
export interface FigureExecuteDeps {
  readonly compute?: typeof buildComputePorts
}

export async function executeFigureGenerate(
  toolCallId: string,
  params: { readonly method_text: string },
  exec: { readonly signal: AbortSignal; readonly onUpdate?: (partial: unknown) => void; readonly ctx: PluginToolContext },
  deps?: FigureExecuteDeps,
): Promise<PluginToolResult<FigureResultDetails>> {
  const ctx = assertFigureContext(exec.ctx)
  const methodText = params.method_text
  // 受理即 created（#744 §11.2 figure_run 创建事实）；其后配置/执行失败落 failed——审计轨迹完整。
  ctx.audit.emitFigureRun({ event: 'created', toolCallId, detail: { methodText: truncateAuditMethodText(methodText) } })
  const usageRef: PluginToolUsage[] = []
  const startedAt = Date.now()
  try {
    const config = readAutofigureConfig(ctx.config)
    const ports = deps?.compute?.(config, ctx, usageRef) ?? buildComputePorts(config, ctx, usageRef)
    // 固定 pipeline graph（非 agent loop）随会话 run 执行（同步长工具调用，#744 §4.1）；
    // 六 stage 经 onUpdate 上报一次（runner 落 SSE/审计双面）。
    const graph = createFigurePipelineGraph(ports, { renderer: 'sharp-librsvg' })
    const result = await graph.invoke(
      { methodText, models: { imageGen: config.imageModel, svg: config.svgModel } },
      { signal: exec.signal, onStage: (stage) => exec.onUpdate?.({ stage }) },
    )
    const { figureId } = await ctx.figures.create({
      prompt: methodText,
      svg: result.finalSvg,
      ...(result.previewPng !== undefined ? { pngBytes: result.previewPng } : {}),
      meta: result.meta,
      sessionId: ctx.run.sessionId,
    })
    const durationMs = Math.max(0, Date.now() - startedAt)
    ctx.audit.emitFigureRun({
      event: 'completed',
      toolCallId,
      detail: { figureId, iterations: result.meta.fixAttempts + result.meta.optimizeCompleted, durationMs },
    })
    // R6 事实同源：content 携带卡上全部结论性事实（figureId/state/previewReady/渲染路径）。
    const content: PluginToolContentBlock[] = [
      {
        type: 'text',
        text: `Figure generated: figureId=${figureId} state=completed previewReady=${result.meta.previewReady ? 'true' : 'false'}. The final SVG is available at GET /api/v1/figures/${figureId}/svg.`,
      },
    ]
    const usage = mergeUsage(usageRef)
    return {
      content,
      details: { figureId, state: 'completed', previewReady: result.meta.previewReady },
      ...(usage !== undefined ? { usage } : {}),
    }
  } catch (e) {
    if (exec.signal.aborted) {
      // 会话 run aborted 联动（#744 §4.1）：无半产物落 Figure 成功态（figures.create 未达即无行）
      ctx.audit.emitFigureRun({ event: 'aborted', toolCallId, detail: { by: 'user' } })
    } else {
      ctx.audit.emitFigureRun({ event: 'failed', toolCallId, detail: { reason: stableReason(e) } })
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// /figure 命令（{execute} outcome 直达同一执行面——#752 R9，两条触发面一条执行面）
// ---------------------------------------------------------------------------

export async function figureCommandHandler(args: string): Promise<{ readonly execute: { readonly tool: typeof FIGURE_TOOL_NAME; readonly args: { readonly method_text: string } } }> {
  // 与 manifest zod .max 同约束的双写是有意的：此处 = REST 面即时反馈（80001 信封直达
  // 用户），zod = 内核执行面契约（直达路径 executePluginToolRun 预校验）——两层面各取。
  const methodText = args.trim()
  if (methodText === '') {
    throw fail(CODE.PLUGINS_VALIDATION_FAILED, '用法：/figure <方法描述文本>')
  }
  if (methodText.length > METHOD_TEXT_MAX) {
    throw fail(CODE.PLUGINS_VALIDATION_FAILED, `方法描述超长（上限 ${METHOD_TEXT_MAX} 字符）`)
  }
  return { execute: { tool: FIGURE_TOOL_NAME, args: { method_text: methodText } } }
}
