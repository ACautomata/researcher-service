// research 单入口意图路由图（853 §2.2 · #849 D2 终形 · #909 骨架票）：
//
//   START → classify →⌗ addConditionalEdges(routeByIntent) → ingest | discover | hypothesize | experiment → END
//                                    └→ end: END（低置信/none clarify 兜底出边）
//
// 形态 1 单 StateGraph + 条件边（#847 选型）：无公共归并节点（路由互斥下恰一分支在跑，
// 分支自终）；嵌套图无 checkpointer（人审走工具边界拆分、低置信走 clarify 回喂——853 §2.2
// 已接受代价）；不进 RunService 图实例缓存（autofigure 同构，工具 execute 内构造执行）。
//
// 风格对齐 plugins/autofigure/pipeline/graph.ts 与 routing-skeleton 验证件：纯函数工厂
//（同参数必同拓扑）、全部计算面经端口注入（图零直连 LLM/文件系统，S2 可 fake）、import
// 一律经桥 server/src/plugins/autofigureDeps.ts（plugins 树禁裸包名 import 铁律）。
//
// seed 透传（853 §2.2）：state 已有 workflow（命令直达 / 主 agent 显式传 / W4 collect 调用）
// → 透传不调分类器；缺省 → 调 IntentClassifier。单一 classify 入口保拓扑恒定（不为 seed 开
// 第二 START 出口）。
// 占位分支：四分支节点 = runWorkflow 端口调用（本票注入占位实现保拓扑可编译 + 互斥分发
// 可测；真实节点链由 [#873·4–6] 三票替换端口注入实现，图拓扑零改动）。

import { END, START, StateGraph, Annotation } from '../../server/src/plugins/autofigureDeps'
import type { LangGraphRunnableConfig } from '../../server/src/plugins/autofigureDeps'
import { buildClarifyResult, isAccepted, WORKFLOW_CATALOG } from './clarify'
import type { ClarifyResult, IntentVerdict, WorkflowLabel } from './clarify'
import { serializeClassifyInput } from './classifier'
import type { IntentClassifier } from './classifier'

// 四流程名（分支节点名 = 流程名，1:1；与 clarify.ts 目录同源）。
export const RESEARCH_WORKFLOW_NAMES = WORKFLOW_CATALOG.map((c) => c.label) as readonly WorkflowLabel[]

// 入口面 stage 白名单（classify + 四分支名）。
export const RESEARCH_ENTRY_STAGES = ['classify', ...RESEARCH_WORKFLOW_NAMES] as const

// 流程内节点 stage（W1/W2/W3 已落地；W4 随实现票补齐，853 §6.1 四流程并集逐票扩展）。
// 跨流程重名（extract/validate/persist/summary/resolveInputs）在 SSE 载荷 workflow 域字段
// 语境下无歧义。
export const RESEARCH_FLOW_STAGES = [
  // W1 ingest 七节点链
  'capture',
  'extract',
  'create',
  'validate',
  'persist',
  'verify',
  'summary',
  // W2 discover 增量节点（resolveInputs/load/critic/evidenceGate；extract/validate/persist/summary 与 W1 重名已含）
  'resolveInputs',
  'load',
  'critic',
  'evidenceGate',
  // W3 hypothesize 增量节点（contextPack/bucket/dedup/challenge；resolveInputs/validate/persist/summary 重名已含）
  'contextPack',
  'bucket',
  'dedup',
  'challenge',
  // W4 experiment 增量节点（#912：preflight/design/spec/audit/plan-review + collect 段
  // collect/summarize；resolveInputs/validate/persist/summary 重名已含——spec/audit 为
  // W4 独有节点名不重名，漏报即最长 LLM 节点 stage 静默丢弃，review 修复补齐）。
  // plan-review = 白名单内唯一非节点名值（人审挂起期 stage，853 §6.1 解读点 D）；
  // executing/collecting 为流程级描述不进白名单。
  'preflight',
  'design',
  'spec',
  'audit',
  'plan-review',
  'collect',
  'summarize',
] as const

// progressStages 声明值（manifest 单源）：入口面 + 已落地流程节点并集。
export const RESEARCH_PROGRESS_STAGES = [...RESEARCH_ENTRY_STAGES, ...RESEARCH_FLOW_STAGES] as const

// 结构化请求面（research_workflow 工具参数 zod 产物的图内同形——单一来源在 server.ts schema，
// 图内消费只读）。buckets = W3 opt-in 桶档位（853 §4.3：仅经参数显式追加——非 LLM 自由裁量；
// 传输面 zod 枚举锁定三值，BucketName 与 values.ts BUCKETS_OPT_IN 单源）。
export interface ResearchWorkflowRequest {
  readonly workflow?: WorkflowLabel
  readonly topic?: string
  readonly question?: string
  readonly source_paths?: readonly string[]
  readonly phase?: 'collect'
  readonly buckets?: readonly ('ablation' | 'metric' | 'assumption-challenge')[]
}

// 流程产物引用（details.artifactPages 面——引用形态不内联页内容，R6 事实同源不变量）。
export interface WorkflowArtifactPage {
  readonly path: string
  readonly title: string
}

// 流程图终态（#910 端口面扩展）：completed 带 summary + 产物页清单；clarify = 分支内
// 兜底出口（W2 论文页缺失 → 提示先 ingest——产物串联，853 §4.2）；plan_review_exhausted =
// W4 人审 3 轮未通过终局（run completed 非 failed 语义，853 §5.1）。plan 面 = W4 批准/
// 终局的方案引用（planRef = spec 落盘路径；note = 批准附言；lastReason = 终局拒绝理由）。
export interface WorkflowOutcome {
  readonly status: 'completed' | 'clarify' | 'plan_review_exhausted'
  readonly summary: string
  readonly artifactPages: readonly WorkflowArtifactPage[]
  readonly clarify?: ClarifyResult
  readonly plan?: {
    readonly planRef: string
    readonly note: string | undefined
    readonly lastReason: string | undefined
  }
}

// 端口面（Strategy 注入——S2 fake 面）。
export interface ResearchRoutingPorts {
  readonly classifier: IntentClassifier
  /** 分支执行（占位/真实流程图调用；onStage 冒泡流程内裸节点名）。 */
  readonly runWorkflow: (
    workflow: WorkflowLabel,
    request: ResearchWorkflowRequest,
    onStage?: (stage: string) => void,
  ) => Promise<WorkflowOutcome>
}

// ---------------------------------------------------------------------------
// wiki 路径域换算（PR #917 review P0#1）：写面与读面路径域不对称——createPage 经
// normalizeRelPath 吃写面 rel（papers/x.md）；readPage 直透 openwiki readWikiSections，
// 其 normalizeWikiPagePath 强制归一化后以 /openwiki/ 开头否则 invalid_input；检索镜像
// 的 search ref 亦带 openwiki/ 前缀。约定：图内状态一律持有写面 rel 域（artifactPages/
// provenance/用户面路径同域），仅在 readPage 调用点经 wikiReadPathOf 换算。
// ---------------------------------------------------------------------------

/** 写面 rel 路径 → 检索读面虚拟前缀形态（papers/x.md → openwiki/papers/x.md）。 */
export const wikiReadPathOf = (relPath: string): string => `openwiki/${relPath}`

/** 检索 ref / 用户输入 → 写面 rel 路径（剥首斜杠与 openwiki/ 虚拟前缀）。 */
export function toWikiRelPath(p: string): string {
  return p.replace(/^\/+/, '').replace(/^openwiki\//, '')
}

// 裸页引用存在性回查哨兵锚（PR #917 review Spec#8 · W2 evidenceGate / W3 resolveInputs 共享）：
// openwiki readPage 需 ≥1 节锚（空锚即拒）——用「合法且理论必不存在」的锚探页存在性：
// not_found = 页不存在；Unknown sections（invalid_input）= 页存在、哨兵节缺失 → 放行。
export const WIKI_PAGE_PROBE_ANCHOR = 'evidence-gate-page-existence-probe'

// ---------------------------------------------------------------------------
// 状态面
// ---------------------------------------------------------------------------

interface RoutingState {
  request: ResearchWorkflowRequest
  intent: IntentVerdict | undefined
  workflow: WorkflowLabel | undefined
  clarify: ClarifyResult | undefined
  outcome: WorkflowOutcome | undefined
}

const RoutingAnnotation = {
  request: Annotation<ResearchWorkflowRequest>,
  intent: Annotation<IntentVerdict | undefined>,
  workflow: Annotation<WorkflowLabel | undefined>,
  clarify: Annotation<ClarifyResult | undefined>,
  outcome: Annotation<WorkflowOutcome | undefined>,
}

// 条件边 path 纯状态派生（S3 单测锁）：workflow 已落 → 同名分支；clarify 已落（低置信/
// none）→ end 出边；空状态防御兜底 → end（分类器输出枚举锁定下理论不可达）。
export interface RoutingRouteState {
  readonly workflow?: WorkflowLabel
  readonly clarify?: ClarifyResult
}

export function routeByIntent(state: RoutingRouteState): WorkflowLabel | 'end' {
  if (state.clarify !== undefined) return 'end'
  if (state.workflow !== undefined) return state.workflow
  return 'end'
}

// ---------------------------------------------------------------------------
// 图工厂（纯函数——同 ports 必同拓扑）
// ---------------------------------------------------------------------------

export interface ResearchRoutingInvokeOptions {
  readonly signal?: AbortSignal
  /** 阶段进度上报（autofigure onStage 先例）→ 翻译面落 research_run.progress（SSE 载荷
   *  {toolCallId, stage, workflow}——workflow 域字段在分支内节点上报时附加，入口面
   *  classify/分支名两值无域字段）。 */
  readonly onStage?: (stage: string, workflow?: WorkflowLabel) => void
}

// 流程图 invoke 选项共享形（W1 ingest / W2 discover 同构，PR #917 review S13 接口双写归口；
// onStage 裸节点名——workflow 域字段由入口图分支节点附加）。
export interface FlowGraphInvokeOptions {
  readonly onStage?: (stage: string) => void
  readonly signal?: AbortSignal
}

// LangGraph compiled.invoke 第二参组装（onStage 走 configurable 通道，signal 直传）——
// 两图 invoke 尾部重复块归口（PR #917 review S13）。
export function compiledInvokeOptions(options: FlowGraphInvokeOptions | undefined): {
  signal?: AbortSignal
  configurable: { onStage?: (stage: string) => void }
} {
  return {
    ...(options?.signal ? { signal: options.signal } : {}),
    configurable: { onStage: options?.onStage },
  }
}

export interface ResearchRoutingResult {
  readonly status: 'branch' | 'clarify'
  /** 分支路径 = 路由到的流程（seed 值或分类标签）；clarify 路径 undefined。 */
  readonly workflow: WorkflowLabel | undefined
  /** 分类产物（seed 透传不调分类器 → undefined）。 */
  readonly intent: IntentVerdict | undefined
  /** clarify 两形态（853 §1.3）：低置信 Top-2 候选 / none 空候选拒识。 */
  readonly clarify: ClarifyResult | undefined
  /** branch：流程终态（summary/artifactPages；分支内 clarify 时 status='clarify'）。
   *  summary 只在 outcome 一处（含多意图尾注）——不设顶层冗余字段（PR #917 review S18）。 */
  readonly outcome: WorkflowOutcome | undefined
}

export interface ResearchRoutingGraph {
  invoke(init: { request: ResearchWorkflowRequest }, options?: ResearchRoutingInvokeOptions): Promise<ResearchRoutingResult>
}

// stage 上报 helper（图内节点统一走此——LangGraphRunnableConfig.configurable.onStage 取
// 用的单点 cast；ingest/discover 流程图节点同款复用，853 §6.1 progress 上报唯一通道）。
export function stageReporterOf(
  config: LangGraphRunnableConfig | undefined,
): (stage: string, workflow?: WorkflowLabel) => void {
  return (stage, workflow) => {
    const onStage = config?.configurable?.onStage as ((stage: string, wf?: WorkflowLabel) => void) | undefined
    onStage?.(stage, workflow)
  }
}

export function createResearchRoutingGraph(ports: ResearchRoutingPorts): ResearchRoutingGraph {
  // 节点 classify（单一入口）：seed 已带 → 透传不调分类器（命令直达/显式传/W4 collect；
  // 命令路径恒带 workflow 永不触发兜底，853 §1.3）；缺省 → 分类器（结构化槽位序列化输入，
  // 解读点 A）→ 阈值判定（isAccepted：none 或 conf < MIN_CONFIDENCE）落 clarify 或 workflow。
  async function classifyNode(
    state: RoutingState,
    config: LangGraphRunnableConfig | undefined,
  ): Promise<Partial<RoutingState>> {
    stageReporterOf(config)('classify')
    const seed = state.request.workflow
    if (seed !== undefined) return { workflow: seed }
    const intent = await ports.classifier(serializeClassifyInput(state.request))
    if (!isAccepted(intent)) {
      return { intent, clarify: buildClarifyResult(intent) }
    }
    return { intent, workflow: intent.label }
  }

  // 四分支节点：入口上报分支名（进入流程信号）→ runWorkflow 端口（真实流程图经第三参数
  // 冒泡流程内裸节点名，域字段 = 本分支 workflow）。
  function makeBranchNode(workflow: WorkflowLabel) {
    return async function branchNode(
      state: RoutingState,
      config: LangGraphRunnableConfig | undefined,
    ): Promise<Partial<RoutingState>> {
      stageReporterOf(config)(workflow)
      const report = stageReporterOf(config)
      const outcome = await ports.runWorkflow(workflow, state.request, (s) => report(s, workflow))
      return { outcome }
    }
  }

  const workflow = new StateGraph({ stateSchema: Annotation.Root(RoutingAnnotation) })
    .addNode('classify', classifyNode)
    .addNode('ingest', makeBranchNode('ingest'))
    .addNode('discover', makeBranchNode('discover'))
    .addNode('hypothesize', makeBranchNode('hypothesize'))
    .addNode('experiment', makeBranchNode('experiment'))
    .addEdge(START, 'classify')
    .addConditionalEdges('classify', routeByIntent, {
      ...Object.fromEntries(RESEARCH_WORKFLOW_NAMES.map((name) => [name, name])),
      end: END,
    })
    .addEdge('ingest', END)
    .addEdge('discover', END)
    .addEdge('hypothesize', END)
    .addEdge('experiment', END)

  const compiled = workflow.compile()

  return {
    async invoke(init, options) {
      const state = await compiled.invoke(
        { request: init.request },
        {
          ...(options?.signal ? { signal: options.signal } : {}),
          configurable: { onStage: options?.onStage },
        },
      )
      if (state.clarify !== undefined) {
        return { status: 'clarify', workflow: undefined, intent: state.intent, clarify: state.clarify, outcome: undefined }
      }
      if (state.workflow === undefined || state.outcome === undefined) {
        // 拓扑终局必有 workflow + outcome（clarify 已上分支；分支节点必写 outcome）——
        // 理论不可达的防御面（autofigure「finished without final SVG」同款）。
        throw new Error('research routing graph finished without branch result')
      }
      // 多意图高置信尾注（853 §1.3 · #850 D17）：选首路由后 summary 尾注引导继续发起；
      // clarify/seed/无次选路径零尾注。同值次选（自指，secondaryIntent = 主选）视为无次选。
      const intent = state.intent
      const secondary = intent?.secondaryIntent !== intent?.label ? intent?.secondaryIntent : undefined
      const summary =
        secondary !== undefined
          ? `${state.outcome.summary}\n\n检测到后续意图 ${secondary}，可继续发起。`
          : state.outcome.summary
      return {
        status: 'branch',
        workflow: state.workflow,
        intent: state.intent,
        clarify: undefined,
        outcome: secondary !== undefined ? { ...state.outcome, summary } : state.outcome,
      }
    },
  }
}
