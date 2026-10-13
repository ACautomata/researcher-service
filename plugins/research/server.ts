// research 插件 server 面实现体（#909 · #752 §1）：research_workflow 工具 execute 与
// 4 命令 handler。manifest.ts 是声明入口，本文件是实现体（autofigure server.ts 同构）。
//
// 工具唯一入口（#744 Q10 先例）：agent 自动调用（NL 路径，promptSnippet/promptGuidelines
// 引导）与 4 命令 {execute} outcome 直达（#752 R9，两条触发面一条执行面）共用本 execute——
// runService.executePluginToolRun 既有面原样：无 agent loop / 无 checkpoint / 终态
// completed / toolCallId 幂等形态（figcmd-<runId> 先例），占用户 run 名额（853 §1.1）。
//
// ctx 消费：run 身份 / llm（generateStructured 封装 IntentClassifier——owner 回退链 +
// 文本退化双保险②在核心）/ audit（created/completed/failed/aborted 四态 + #912 方案人审
// recordToolApproval 落 tool_approval_logs）/ wiki/docs（W1/W2/W3）/ lab（#912 W4 spec
// 落盘窄口）。W4 人审闸门（853 §5.1）：agent 路径（图执行上下文）工具内 interrupt 挂起
// 等审批；{execute} 命令直达无图上下文 → clarify 引导 NL（无条件人审不破——命令路径
// 不进方案生成）。
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
import { createExperimentPlanGraph } from './experiment'
import { createExperimentCollectGraph } from './collect'
import { runPlanReviewLoop } from './planReview'
import { buildExperimentPlan, specPathOf } from './experimentPlan'
import { BUCKETS_OPT_IN, PLAN_REVIEW_MAX_ROUNDS, SOURCE_PATHS_V1_MAX } from './values'
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
// 引用形态不内联页内容（R6 事实同源不变量）。status 四值面（853 §6.2）：completed /
// clarify / approved（W4 调用①批准——spec 路径由 summary 文本承载）/ plan_review_exhausted
// （3 轮未通过终局，run completed 非错误面）。
export interface ResearchRunDetails {
  readonly workflow: WorkflowLabel | undefined
  readonly status: 'completed' | 'clarify' | 'approved' | 'plan_review_exhausted'
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
  readonly lab: NonNullable<PluginToolContext['lab']>
  readonly logger: PluginToolContext['logger']
}

export function assertResearchContext(ctx: PluginToolContext): ResearchToolContext {
  const missing = [
    ...(ctx.run ? [] : ['run']),
    ...(ctx.llm ? [] : ['llm']),
    ...(ctx.audit ? [] : ['audit']),
    ...(ctx.wiki ? [] : ['wiki']),
    ...(ctx.docs ? [] : ['docs']),
    ...(ctx.lab ? [] : ['lab']),
  ]
  if (missing.length > 0) {
    throw new Error(`research tool requires runner-assembled plugin context; missing: ${missing.join(', ')}`)
  }
  return ctx as unknown as ResearchToolContext
}

// ---------------------------------------------------------------------------
// 分支分派（#910/#911/#912）：ingest/discover/hypothesize = 真实流程图（853 §4.1–§4.3）；
// experiment = W4 三调用两段式（调用①方案设计图 + 工具内人审循环；调用③ collect 图——
// phase='collect' 槽位分派）。RESEARCH_MODEL 面板级可选 pin（853 §3.1）统一包装进流程图
// llm 面（分类器已单独 pin）——图内 generateStructured 零 pin 知识。
// ---------------------------------------------------------------------------

// pin 包装（空 = owner 默认链 primary 原样透传；非空 = 每次调用带 model pin 语义）。
function pinLlm(llm: PluginLlmPort, pinnedModel: string | undefined): PluginLlmPort {
  const pin = pinnedModelOf(pinnedModel)
  if (pin === undefined) return llm
  return {
    generateMultimodal: (opts) => llm.generateMultimodal({ ...opts, model: pin }),
    generateStructured: (opts) => llm.generateStructured({ ...opts, model: pin }),
  }
}

// ---------------------------------------------------------------------------
// W4 人审闸门（853 §5.1 · #852）——工具内 interrupt 循环（planReview.ts）接线：
//   agent 路径（exec.interrupt 可挂起）→ 方案循环：buildPlan（图 invoke——spec 短路点保
//   resume 重放零 LLM 重调）→ interrupt 挂审 → approve 续执行段 / deny 回修订（≤3 轮）→
//   exhausted 终局（run completed 非 failed）。
//   {execute} 命令直达（exec.interrupt undefined——无图上下文不可恢复挂起）→ clarify
//   引导 NL 路径（无条件人审不破：命令路径不进方案生成）。
// 审计：approve/deny 逐轮落 tool_approval_logs（ctx.audit.recordToolApproval——audit sink
// 自动补 traceId/runId/userId；写失败 fail-closed throw）。
// ---------------------------------------------------------------------------

const EXPERIMENT_DIRECT_CLARIFY: ClarifyResult = {
  status: 'clarify',
  candidates: [],
  question:
    '实验流程的方案人审闸门需要对话式会话支撑（审批卡挂起/恢复/修订）——/experiment 命令直达路径不可挂起。请直接用自然语言描述实验需求（如「帮我设计实验验证 X，输入是 critic 页 …」），系统将走完整设计 + 人审 + 执行段流程。',
}

async function runExperimentWithReview(input: {
  readonly ctx: ResearchToolContext
  readonly llm: PluginLlmPort
  readonly exec: PluginToolExec
  readonly toolCallId: string
  readonly request: ResearchWorkflowRequest
  readonly onStage?: (stage: string) => void
}): Promise<WorkflowOutcome> {
  const { ctx, llm, exec, toolCallId, request, onStage } = input
  // 命令直达：无图上下文 → 人审不可用 → clarify 引导（工具正常 completed 终态）。
  if (exec.interrupt === undefined) {
    return { status: 'clarify', summary: '', artifactPages: [], clarify: EXPERIMENT_DIRECT_CLARIFY }
  }
  const graph = createExperimentPlanGraph({ llm, wiki: ctx.wiki, lab: ctx.lab })
  const buildPlan = async (revisionReason: string | undefined, round: number) => {
    // 修订轮不发新 stage（853 §6.2）：非首轮/修订轮的图执行与挂审上报静默——进度语义
    // 归审批卡 round 面（escalation.plan.round），SSE 面不重放/续发 stage 序列。
    const report = round === 1 && revisionReason === undefined ? onStage : undefined
    const r = await graph.invoke(
      { request, round, ...(revisionReason !== undefined ? { revisionReason } : {}) },
      { onStage: report },
    )
    if (r.status === 'clarify') return r.clarify!
    if (r.experiment === undefined) throw new Error('experiment plan graph finished without plan payload')
    // 挂起期 stage 停 plan-review（853 §6.1：白名单内唯一非节点名值）——图跑完后、
    // interrupt 前上报（挂起即末态 stage）。
    report?.('plan-review')
    return buildExperimentPlan(request, { content: r.experiment.specContent }, round)
  }
  const recordApproval = async (row: {
    readonly layer: 'human'
    readonly decision: 'allow' | 'deny'
    readonly toolName: string
    readonly toolCall: string
    readonly reason?: string
  }) => {
    if (ctx.audit.recordToolApproval === undefined) {
      throw new Error('方案人审审计面不可用（audit.recordToolApproval 缺省）——审批是安全路径，fail-closed')
    }
    const ok = await ctx.audit.recordToolApproval(row)
    if (!ok) throw new Error('方案人审审计写入失败——审批是安全路径，fail-closed')
  }
  const result = await runPlanReviewLoop({
    toolCallId,
    buildPlan,
    hooks: { interrupt: exec.interrupt, recordAudit: recordApproval },
  })
  if (result.outcome === 'clarify') {
    return { status: 'clarify', summary: '', artifactPages: [], clarify: result.clarify }
  }
  if (result.outcome === 'approved') {
    // 批准后续执行段（853 §5.1：promptSnippet 约定「批准后立即执行」——content 经主
    // agent 组织：附言 = 执行注意事项；spec 引用 = collect 的输入面）。
    const note = result.note !== undefined ? `\n执行注意事项（审批附言）：${result.note}` : ''
    return {
      status: 'completed',
      summary: `实验方案已批准（spec：${result.plan.specRef}）。请立即按规格在沙箱执行：长命令 nohup 后台化，结果文件写入 spec 交付物声明的 /lab/ 路径；执行完成后发起 phase='collect' 对账产出实验报告页。${note}`,
      artifactPages: [],
      plan: { planRef: result.plan.specRef, note: result.note, lastReason: undefined },
    }
  }
  // exhausted：终局文案（主 agent 向用户说明；spec 停留 lab，run completed 非 failed）。
  return {
    status: 'plan_review_exhausted',
    summary: `实验方案 3 轮审批未通过，流程终止（spec 保留在 ${result.planRef ?? specPathOf(request, PLAN_REVIEW_MAX_ROUNDS)} 供参考）。最后一轮拒绝理由：${result.lastReason}`,
    artifactPages: [],
    plan: { planRef: result.planRef ?? '', note: undefined, lastReason: result.lastReason },
  }
}

function buildRoutingPorts(ctx: ResearchToolContext, exec: PluginToolExec, toolCallId: string): ResearchRoutingPorts {
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
    // W4 experiment（#912）：collect 相位 → 调用③对账图；否则调用① + 人审闸门。
    if (request.phase === 'collect') {
      return createExperimentCollectGraph({ llm, wiki: ctx.wiki, lab: ctx.lab }).invoke({ request }, { onStage })
    }
    return runExperimentWithReview({ ctx, llm, exec, toolCallId, request, onStage })
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
    const graph = createResearchRoutingGraph(buildRoutingPorts(ctx, exec, toolCallId))
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
        ...(outcome.plan !== undefined ? { planRef: outcome.plan.planRef } : {}),
        methodText: truncateAuditMethodText(outcome.summary),
      },
    })
    const content: PluginToolContentBlock[] = [{ type: 'text', text: outcome.summary }]
    // W4 终态映射（853 §6.2）：approved = 调用①批准（spec 引用 + 附言由 summary 承载）；
    // plan_review_exhausted = 3 轮未通过终局（run completed 非错误面）。其余 completed。
    const detailsStatus =
      outcome.plan !== undefined
        ? outcome.status === 'plan_review_exhausted'
          ? 'plan_review_exhausted'
          : 'approved'
        : 'completed'
    return {
      content,
      details: {
        workflow: result.workflow,
        status: detailsStatus,
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
