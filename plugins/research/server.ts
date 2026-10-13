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
  PluginLlmPort,
  PluginToolContentBlock,
  PluginToolContext,
  PluginToolExec,
  PluginToolResult,
} from '../../server/src/plugins/api'
import { fail } from '../../server/src/envelope'
import { CODE } from '../../server/src/codes'
import { truncateAuditMethodText } from '../../server/src/figures/figureAudit'
import { createResearchRoutingGraph } from './graph'
import type { ResearchWorkflowRequest, ResearchRoutingPorts, WorkflowOutcome } from './graph'
import { toWikiRelPath } from './graph'
import { createIntentClassifier, pinnedModelOf, serializeClassifyInput, type WorkflowLabel } from './classifier'
import { createIngestGraph } from './ingest'
import { createDiscoverGraph } from './discover'
import { createHypothesizeGraph } from './hypothesize'
import { BUCKETS_OPT_IN, SOURCE_PATHS_V1_MAX } from './values'
import { WORKFLOW_CATALOG } from './clarify'
import type { ClarifyResult } from './clarify'

export const RESEARCH_TOOL_NAME = 'research_workflow'

// 输入边界（zod 0 信任红线）：文本槽位上限 = openwiki 检索 queryCharacters 面（2000，
// wiki.d.ts WIKI_RETRIEVAL_LIMITS——W2 resolveInputs 把 question 直传 search，超限落
// invalid_input 误导性 clarify，故在入口即收紧，PR #917 review Spec#19；分类输入天然短，
// 853 §7.2）；source_paths 数组上限为传输面（W3/W4 共用），流程级 V1 单篇约束在
// values.SOURCE_PATHS_V1_MAX（PR #917 review S8 分层）；buckets = W3 opt-in 桶（853 §4.3
// 仅经参数显式追加——枚举锁三值，LLM 无自由裁量）。
export const INPUT_TEXT_MAX = 2000
export const SOURCE_PATHS_MAX = 32

const WORKFLOW_ENUM = ['ingest', 'discover', 'hypothesize', 'experiment'] as const

export const researchToolParameters = z
  .object({
    workflow: z.enum(WORKFLOW_ENUM).optional(),
    topic: z.string().min(1).max(INPUT_TEXT_MAX).optional(),
    question: z.string().min(1).max(INPUT_TEXT_MAX).optional(),
    source_paths: z.array(z.string().min(1)).max(SOURCE_PATHS_MAX).optional(),
    phase: z.literal('collect').optional(), // W4 调用③ 专用槽位（853 §1.1 · #850 D2）
    buckets: z.array(z.enum(BUCKETS_OPT_IN)).max(BUCKETS_OPT_IN.length).optional(),
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
// 明确报错不静默降级。本票起六件全消费（W1/W2 图取 llm/wiki/docs；run/audit 审计面）。
// ---------------------------------------------------------------------------

interface ResearchToolContext {
  readonly config: Readonly<Record<string, string>>
  readonly run: NonNullable<PluginToolContext['run']>
  readonly llm: NonNullable<PluginToolContext['llm']>
  readonly audit: NonNullable<PluginToolContext['audit']>
  readonly wiki: NonNullable<PluginToolContext['wiki']>
  readonly docs: NonNullable<PluginToolContext['docs']>
  readonly logger: PluginToolContext['logger']
}

export function assertResearchContext(ctx: PluginToolContext): ResearchToolContext {
  const missing = [
    ...(ctx.run ? [] : ['run']),
    ...(ctx.llm ? [] : ['llm']),
    ...(ctx.audit ? [] : ['audit']),
    ...(ctx.wiki ? [] : ['wiki']),
    ...(ctx.docs ? [] : ['docs']),
  ]
  if (missing.length > 0) {
    throw new Error(`research tool requires runner-assembled plugin context; missing: ${missing.join(', ')}`)
  }
  return ctx as unknown as ResearchToolContext
}

// ---------------------------------------------------------------------------
// 分支分派（#910/#911）：ingest/discover/hypothesize = 真实流程图（853 §4.1–§4.3）；
// experiment 保持占位（[#873·6] 票替换）。RESEARCH_MODEL 面板级可选 pin（853 §3.1）统一
// 包装进流程图 llm 面（分类器已单独 pin）——图内 generateStructured 零 pin 知识。
// ---------------------------------------------------------------------------

// 四流程中文名自 clarify 目录派生（单一来源——WORKFLOW_CATALOG.name，防双表漂移）。
const WORKFLOW_DISPLAY: Record<WorkflowLabel, string> = Object.fromEntries(
  WORKFLOW_CATALOG.map((c) => [c.label, c.name]),
) as Record<WorkflowLabel, string>

function placeholderRunWorkflow(workflow: WorkflowLabel): Promise<WorkflowOutcome> {
  return Promise.resolve({
    status: 'completed',
    summary: `已受理 ${WORKFLOW_DISPLAY[workflow]}（${workflow}）流程。插件骨架已就绪，该流程的节点链将在后续版本接入；本次运行不产出 wiki 页面。`,
    artifactPages: [],
  })
}

// pin 包装（空 = owner 默认链 primary 原样透传；非空 = 每次调用带 model pin 语义）。
function pinLlm(llm: PluginLlmPort, pinnedModel: string | undefined): PluginLlmPort {
  const pin = pinnedModelOf(pinnedModel)
  if (pin === undefined) return llm
  return {
    generateMultimodal: (opts) => llm.generateMultimodal({ ...opts, model: pin }),
    generateStructured: (opts) => llm.generateStructured({ ...opts, model: pin }),
  }
}

function buildRoutingPorts(ctx: ResearchToolContext): ResearchRoutingPorts {
  const classifier = createIntentClassifier(ctx.llm, ctx.config.RESEARCH_MODEL)
  const llm = pinLlm(ctx.llm, ctx.config.RESEARCH_MODEL)
  const runWorkflow: ResearchRoutingPorts['runWorkflow'] = async (workflow, request, onStage) => {
    if (workflow === 'ingest') {
      return createIngestGraph({ docs: ctx.docs, llm, wiki: ctx.wiki }).invoke({ request }, { onStage })
    }
    if (workflow === 'discover') {
      return createDiscoverGraph({ llm, wiki: ctx.wiki }).invoke({ request }, { onStage })
    }
    if (workflow === 'hypothesize') {
      return createHypothesizeGraph({ llm, wiki: ctx.wiki }).invoke({ request }, { onStage })
    }
    return placeholderRunWorkflow(workflow)
  }
  return { classifier, runWorkflow }
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
  // 受理即 created（figure 先例）；分类输入同一序列化单源截断落审计（topic/question 面）；
  // source_paths 落 detail JSON 面（methodText 不含数据槽位——ingest 受理文件清单经
  // outputText 全量 detail 可检索）。
  const classificationInput = serializeClassifyInput(request)
  ctx.audit.emitPluginRun({
    event: 'created',
    toolCallId,
    detail: {
      ...(request.workflow !== undefined ? { workflow: request.workflow } : {}),
      ...(request.phase !== undefined ? { phase: request.phase } : {}),
      ...(request.source_paths !== undefined ? { source_paths: request.source_paths } : {}),
      ...(request.buckets !== undefined ? { buckets: request.buckets } : {}),
      methodText: truncateAuditMethodText(classificationInput),
    },
  })
  try {
    const graph = createResearchRoutingGraph(buildRoutingPorts(ctx))
    const result = await graph.invoke(
      { request },
      // stage 上报（853 §6.1：SSE 载荷 {toolCallId, stage, workflow}）——入口面两值
      //（classify/分支名）无域字段；流程内节点冒泡时附加 workflow 域字段（跨流程重名
      // stage 的语境面），runner 翻译面作 extra 透传 SSE + stage_transitions 双面。
      {
        signal: exec.signal,
        onStage: (stage, workflow) => exec.onUpdate?.({ stage, ...(workflow !== undefined ? { workflow } : {}) }),
      },
    )
    // clarify 统一回喂（853 §1.3 入口级 + #910 分支级同形态，PR #917 review S22 块级
    // 重复归口）：content = clarify Result JSON（主 agent 可解析、自然语言反问）；
    // details.status=clarify（前端卡纯展示归第 7 票）。工具正常 completed 终态。
    const clarify = result.status === 'clarify' ? result.clarify : result.outcome?.clarify
    if (clarify !== undefined) {
      ctx.audit.emitPluginRun({
        event: 'completed',
        toolCallId,
        detail: { status: 'clarify', ...(result.workflow !== undefined ? { workflow: result.workflow } : {}) },
      })
      return {
        content: [{ type: 'text', text: JSON.stringify(clarify) }],
        details: {
          workflow: result.workflow,
          status: 'clarify',
          artifactPages: [],
          clarify,
        },
      }
    }
    const outcome = result.outcome!
    ctx.audit.emitPluginRun({
      event: 'completed',
      toolCallId,
      detail: {
        workflow: result.workflow,
        ...(outcome.artifactPages.length > 0 ? { artifactPages: outcome.artifactPages } : {}),
        methodText: truncateAuditMethodText(outcome.summary),
      },
    })
    const content: PluginToolContentBlock[] = [{ type: 'text', text: outcome.summary }]
    return {
      content,
      details: {
        workflow: result.workflow,
        status: 'completed',
        artifactPages: outcome.artifactPages,
        summary: outcome.summary,
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

// 命令用法文案单源（PR #917 review r1 S 新4：manifest description 与 failUsage 拒绝面
// 共引本组常量——双写归一；import 方向 manifest → server 不成环）。
export const INGEST_USAGE = '/ingest <PDF 路径>（/lab/uploads 下；V1 单篇——一次一篇）'
export const DISCOVER_USAGE = '/discover <研究问题或论文主题> [papers/<slug>.md]'
export const HYPOTHESIZE_USAGE = '/hypothesize <研究主题>'
export const EXPERIMENT_USAGE = '/experiment <要验证的问题或想法>'

// /discover 可选论文页路径 token（PR #917 review Spec#26：W2 钉定输入的命令面槽位——
// 命中 tokens 从问题文本剥离为 source_paths，余量拼回 question）。
const WIKI_PAGE_TOKEN = /^(?:openwiki\/)?papers\/\S+\.md$/i

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
  if (source_paths.length > SOURCE_PATHS_V1_MAX) {
    throw fail(CODE.PLUGINS_VALIDATION_FAILED, `ingest V1 单篇：一次一篇（收到 ${source_paths.length} 个路径），请逐篇发起`)
  }
  return { execute: { tool: RESEARCH_TOOL_NAME, args: { source_paths, workflow: 'ingest' } } }
}

export async function discoverCommandHandler(
  args: string,
): Promise<
  ResearchCommandOutcome<{
    readonly question?: string
    readonly source_paths?: readonly string[]
    readonly workflow: 'discover'
  }>
> {
  const tokens = textSlot(args, DISCOVER_USAGE).split(/\s+/)
  const source_paths = tokens.filter((t) => WIKI_PAGE_TOKEN.test(t)).map(toWikiRelPath)
  const question = tokens.filter((t) => !WIKI_PAGE_TOKEN.test(t)).join(' ')
  if (question === '' && source_paths.length === 0) failUsage(DISCOVER_USAGE)
  return {
    execute: {
      tool: RESEARCH_TOOL_NAME,
      args: {
        ...(question !== '' ? { question } : {}),
        ...(source_paths.length > 0 ? { source_paths } : {}),
        workflow: 'discover' as const,
      },
    },
  }
}

export async function hypothesizeCommandHandler(
  args: string,
): Promise<ResearchCommandOutcome<{ readonly topic: string; readonly workflow: 'hypothesize' }>> {
  return { execute: { tool: RESEARCH_TOOL_NAME, args: { topic: textSlot(args, HYPOTHESIZE_USAGE), workflow: 'hypothesize' } } }
}

export async function experimentCommandHandler(
  args: string,
): Promise<ResearchCommandOutcome<{ readonly question: string; readonly workflow: 'experiment' }>> {
  return { execute: { tool: RESEARCH_TOOL_NAME, args: { question: textSlot(args, EXPERIMENT_USAGE), workflow: 'experiment' } } }
}
