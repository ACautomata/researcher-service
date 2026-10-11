// research 插件 server 面实现体（#909 · #752 §1）：research_workflow 工具 execute 与
// 4 命令 handler。manifest.ts 是声明入口，本文件是实现体（autofigure server.ts 同构）。
//
// 工具唯一入口（#744 Q10 先例）：agent 自动调用（NL 路径，promptSnippet/promptGuidelines
// 引导）与 4 命令 {execute} outcome 直达（#752 R9，两条触发面一条执行面）共用本 execute——
// runService.executePluginToolRun 既有面原样：无 agent loop / 无 checkpoint / 终态
// completed / toolCallId 幂等形态（figcmd-<runId> 先例），占用户 run 名额（853 §1.1）。
//
// ctx 消费：run 身份 / llm（generateStructured 封装 IntentClassifier——owner 回退链 +
// 文本退化双保险②在核心）/ audit（created/completed/failed/aborted 四态）。本票占位分支
// 零 wiki/docs 消费（真实节点链三票接入后由 runWorkflow 端口取用）。
//
// 审计分工（#744 §11.2）：stage 变化只经 onUpdate 上报一次（SSE research_run.progress 与
// TextTrace stage_transitions 双面由 runner 翻译面落——manifest progressStages 白名单放行）。

import { z } from '../../server/src/plugins/autofigureDeps'
import type {
  PluginToolContentBlock,
  PluginToolContext,
  PluginToolExec,
  PluginToolResult,
} from '../../server/src/plugins/api'
import { fail } from '../../server/src/envelope'
import { CODE } from '../../server/src/codes'
import { truncateAuditMethodText } from '../../server/src/figures/figureAudit'
import { createResearchRoutingGraph } from './graph'
import type { ResearchWorkflowRequest, ResearchRoutingPorts } from './graph'
import { createIntentClassifier, serializeClassifyInput, type WorkflowLabel } from './classifier'
import { WORKFLOW_CATALOG } from './clarify'
import type { ClarifyResult } from './clarify'

export const RESEARCH_TOOL_NAME = 'research_workflow'

// 输入边界（zod 0 信任红线）：文本槽位上限与 figure METHOD_TEXT_MAX 同族（4000 UTF-16
// 单元；分类输入天然短，853 §7.2）；source_paths 数组上限防失控值。
export const INPUT_TEXT_MAX = 4000
export const SOURCE_PATHS_MAX = 32

const WORKFLOW_ENUM = ['ingest', 'discover', 'hypothesize', 'experiment'] as const

export const researchToolParameters = z
  .object({
    workflow: z.enum(WORKFLOW_ENUM).optional(),
    topic: z.string().min(1).max(INPUT_TEXT_MAX).optional(),
    question: z.string().min(1).max(INPUT_TEXT_MAX).optional(),
    source_paths: z.array(z.string().min(1)).max(SOURCE_PATHS_MAX).optional(),
    phase: z.literal('collect').optional(), // W4 调用③ 专用槽位（853 §1.1 · #850 D2）
  })
  .strict()

export type ResearchWorkflowParams = z.infer<typeof researchToolParameters>

// details 形状（853 §6.2 #851 D12 契约面；前端 ResearchRunCard 消费归第 7 票）：
// 引用形态不内联页内容（R6 事实同源不变量）。占位期 artifactPages 恒空。
export interface ResearchRunDetails {
  readonly workflow: WorkflowLabel | undefined
  readonly status: 'completed' | 'clarify'
  readonly artifactPages: readonly { path: string; title: string }[]
  readonly summary?: string
  readonly clarify?: ClarifyResult
}

// ---------------------------------------------------------------------------
// ctx 校验（autofigure assertFigureContext 同款）：缺件 = 无 runner 装配的调用面——
// 明确报错不静默降级。本票消费 llm/audit/run 三件（占位分支零 wiki/docs 面）。
// ---------------------------------------------------------------------------

interface ResearchToolContext {
  readonly config: Readonly<Record<string, string>>
  readonly run: NonNullable<PluginToolContext['run']>
  readonly llm: NonNullable<PluginToolContext['llm']>
  readonly audit: NonNullable<PluginToolContext['audit']>
  readonly logger: PluginToolContext['logger']
}

export function assertResearchContext(ctx: PluginToolContext): ResearchToolContext {
  const missing = [
    ...(ctx.run ? [] : ['run']),
    ...(ctx.llm ? [] : ['llm']),
    ...(ctx.audit ? [] : ['audit']),
  ]
  if (missing.length > 0) {
    throw new Error(`research tool requires runner-assembled plugin context; missing: ${missing.join(', ')}`)
  }
  return ctx as unknown as ResearchToolContext
}

// ---------------------------------------------------------------------------
// 占位分支注入（#909）：四流程真实节点链归 [#873·4–6] 三票替换 runWorkflow 端口实现，
// 图拓扑零改动（graph.ts 端口面已钉）。占位产出说明形态供 S2 互斥分发测试与端到端冒烟。
// ---------------------------------------------------------------------------

// 四流程中文名自 clarify 目录派生（单一来源——WORKFLOW_CATALOG.name，防双表漂移）。
const WORKFLOW_DISPLAY: Record<WorkflowLabel, string> = Object.fromEntries(
  WORKFLOW_CATALOG.map((c) => [c.label, c.name]),
) as Record<WorkflowLabel, string>

function placeholderRunWorkflow(workflow: WorkflowLabel): Promise<string> {
  return Promise.resolve(
    `已受理 ${WORKFLOW_DISPLAY[workflow]}（${workflow}）流程。插件骨架已就绪，该流程的节点链将在后续版本接入；本次运行不产出 wiki 页面。`,
  )
}

function buildRoutingPorts(ctx: ResearchToolContext): ResearchRoutingPorts {
  // RESEARCH_MODEL 面板级可选 pin（853 §3.1 configSchema 单键）：空 = owner 默认链 primary。
  const classifier = createIntentClassifier(ctx.llm, ctx.config.RESEARCH_MODEL)
  return { classifier, runWorkflow: (workflow) => placeholderRunWorkflow(workflow) }
}

// 失败原因稳定非敏感（#744 §11.2 failed{reason} 同款：错误消息截断，不落凭证/响应体）。
function stableReason(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw
}

// ---------------------------------------------------------------------------
// research_workflow 工具 execute（唯一执行面）
// ---------------------------------------------------------------------------

export async function executeResearchWorkflow(
  toolCallId: string,
  params: ResearchWorkflowParams,
  exec: PluginToolExec,
): Promise<PluginToolResult<ResearchRunDetails>> {
  const ctx = assertResearchContext(exec.ctx)
  const request: ResearchWorkflowRequest = params
  // 受理即 created（figure 先例）；分类输入同一序列化单源截断落审计（topic/question 面）。
  const classificationInput = serializeClassifyInput(request)
  ctx.audit.emitPluginRun({
    event: 'created',
    toolCallId,
    detail: {
      ...(request.workflow !== undefined ? { workflow: request.workflow } : {}),
      ...(request.phase !== undefined ? { phase: request.phase } : {}),
      methodText: truncateAuditMethodText(classificationInput),
    },
  })
  try {
    const graph = createResearchRoutingGraph(buildRoutingPorts(ctx))
    const result = await graph.invoke(
      { request },
      // stage 上报（853 §6.1：SSE 载荷 {toolCallId, stage, workflow}）——workflow 域字段
      // 待三票 runWorkflow 端口冒泡时附加（占位期分支名即流程名，无重名消歧需求）。
      { signal: exec.signal, onStage: (stage) => exec.onUpdate?.({ stage }) },
    )
    if (result.status === 'clarify') {
      // clarify 回喂（853 §1.3）：content = clarify Result JSON（主 agent 可解析、自然语言
      // 反问）；details.status=clarify（前端卡纯展示归第 7 票）。工具正常 completed 终态。
      ctx.audit.emitPluginRun({ event: 'completed', toolCallId, detail: { status: 'clarify' } })
      const content: PluginToolContentBlock[] = [{ type: 'text', text: JSON.stringify(result.clarify) }]
      return {
        content,
        details: { workflow: undefined, status: 'clarify', artifactPages: [], clarify: result.clarify },
      }
    }
    ctx.audit.emitPluginRun({
      event: 'completed',
      toolCallId,
      detail: { workflow: result.workflow, methodText: truncateAuditMethodText(result.summary ?? '') },
    })
    const content: PluginToolContentBlock[] = [{ type: 'text', text: result.summary ?? '' }]
    return {
      content,
      details: {
        workflow: result.workflow,
        status: 'completed',
        artifactPages: [],
        ...(result.summary !== undefined ? { summary: result.summary } : {}),
      },
    }
  } catch (e) {
    if (exec.signal.aborted) {
      // 会话 run aborted 联动（figure 先例）。
      ctx.audit.emitPluginRun({ event: 'aborted', toolCallId, detail: { by: 'user' } })
    } else {
      ctx.audit.emitPluginRun({ event: 'failed', toolCallId, detail: { reason: stableReason(e) } })
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// 4 命令 handler（853 §1.1）：{execute} 直达同一执行面——input 槽位 + workflow 显式值。
// 命令路径恒带 workflow 永不触发分类兜底（seed 透传，853 §1.3）。V1 无参数补全
//（resolveInputs 诊断兜底归三票）；空/超长 args = REST 面即时反馈 fail（与 manifest zod
// 内核面双写有意——figure 先例：此处 = 80001 信封直达用户，zod = 内核执行面契约）。
// ---------------------------------------------------------------------------

const INGEST_USAGE = '/ingest <文件路径...>（/lab/uploads 下的 PDF，空格分隔）'

// 命令 handler 统一返回形（{execute} 直达 research_workflow——PluginCommandOutcome 的
// research 收窄面；args 槽位随命令各异，共享 tool 锚定 + workflow 显式值形状）。
interface ResearchCommandOutcome<A> {
  readonly execute: { readonly tool: typeof RESEARCH_TOOL_NAME; readonly args: A }
}

function failUsage(usage: string): never {
  throw fail(CODE.PLUGINS_VALIDATION_FAILED, `用法：${usage}`)
}

function textSlot(args: string, usage: string): string {
  const text = args.trim()
  if (text === '') failUsage(usage)
  if (text.length > INPUT_TEXT_MAX) {
    throw fail(CODE.PLUGINS_VALIDATION_FAILED, `参数超长（上限 ${INPUT_TEXT_MAX} 字符）`)
  }
  return text
}

export async function ingestCommandHandler(
  args: string,
): Promise<ResearchCommandOutcome<{ readonly source_paths: readonly string[]; readonly workflow: 'ingest' }>> {
  const source_paths = textSlot(args, INGEST_USAGE).split(/\s+/).filter((p) => p !== '')
  if (source_paths.length === 0) failUsage(INGEST_USAGE)
  if (source_paths.length > SOURCE_PATHS_MAX) {
    throw fail(CODE.PLUGINS_VALIDATION_FAILED, `文件数超上限（${SOURCE_PATHS_MAX}）`)
  }
  return { execute: { tool: RESEARCH_TOOL_NAME, args: { source_paths, workflow: 'ingest' } } }
}

export async function discoverCommandHandler(
  args: string,
): Promise<ResearchCommandOutcome<{ readonly question: string; readonly workflow: 'discover' }>> {
  return { execute: { tool: RESEARCH_TOOL_NAME, args: { question: textSlot(args, '/discover <研究问题或论文主题>'), workflow: 'discover' } } }
}

export async function hypothesizeCommandHandler(
  args: string,
): Promise<ResearchCommandOutcome<{ readonly topic: string; readonly workflow: 'hypothesize' }>> {
  return { execute: { tool: RESEARCH_TOOL_NAME, args: { topic: textSlot(args, '/hypothesize <研究主题>'), workflow: 'hypothesize' } } }
}

export async function experimentCommandHandler(
  args: string,
): Promise<ResearchCommandOutcome<{ readonly question: string; readonly workflow: 'experiment' }>> {
  return { execute: { tool: RESEARCH_TOOL_NAME, args: { question: textSlot(args, '/experiment <要验证的问题或想法>'), workflow: 'experiment' } } }
}
