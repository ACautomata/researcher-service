// 意图路由图最小骨架（R1 / issue #847）——「单入口 → 意图分类 → 4 固定分支」形态 1 验证件：
// 单 StateGraph + addConditionalEdges（对比与选型论证见同目录 FINDINGS.md 与 issue #847 决议评论）。
//
// 风格对齐 plugins/autofigure/pipeline/graph.ts：纯工厂（同参数必同拓扑）、全部计算面经端口
// 注入（图零直连 LLM/文件系统）、import 一律经桥 server/src/plugins/autofigureDeps.ts。
// 本文件是研究工件：docs/research/ 树不入 server tsconfig include，类型检查走同目录 tsconfig.json。
//
// 拓扑：
//   START → classify（结构化输出意图分类，Command 回写 intent）
//         →⌗ addConditionalEdges(routeByIntent, pathMap)  ← 4 固定分支路由
//         → literature / data / methodGate→method / writing
//         → synthesize → END
//   methodGate 演示分支内 interrupt/resume（configurable.confirmRoute=true 时）：
//     interrupt 抛出 → run 落 interrupted → 调用方以 Command({resume:{proceed:…}}) 续跑；
//     resume 值非 proceed → Command({update, goto: END}) 提前终止（abort 语义同 runService）。

import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
  z,
} from '../../../server/src/plugins/autofigureDeps'
import type {
  BaseCheckpointSaver,
  BaseLanguageModelInput,
  LangGraphRunnableConfig,
  Runnable,
} from '../../../server/src/plugins/autofigureDeps'

// ---------------------------------------------------------------------------
// 状态面
// ---------------------------------------------------------------------------

export const BRANCH_NAMES = ['literature', 'data', 'method', 'writing'] as const
export type BranchName = (typeof BRANCH_NAMES)[number]

// 意图分类的结构化输出 schema（zod v3 形态；withStructuredOutput 的 ZodV3Like 重载直接消费，
// 调用方：model.withStructuredOutput(INTENT_SCHEMA) —— 产物即下方 IntentClassifier 类型）。
export const INTENT_SCHEMA = z.object({
  label: z.enum(['literature', 'data', 'method', 'writing']),
  confidence: z.number(),
})
export type Intent = z.infer<typeof INTENT_SCHEMA>

export interface BranchResult {
  readonly branch: BranchName
  readonly output: string
}

export interface RoutingState {
  input: string
  intent: Intent | undefined
  /** reducer 追加（非覆盖）——并行 Send 扇入（fanoutGraph.ts）复用同一归并语义。 */
  branchResults: BranchResult[]
  answer: string | undefined
}

const RoutingAnnotation = {
  input: Annotation<string>,
  intent: Annotation<Intent | undefined>,
  branchResults: Annotation<BranchResult[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  answer: Annotation<string | undefined>,
}

// ---------------------------------------------------------------------------
// 端口面（Strategy/依赖注入：图的全部计算经此注入，S2 可 fake）
// ---------------------------------------------------------------------------

// = withStructuredOutput(INTENT_SCHEMA) 的产物类型（Runnable<BaseLanguageModelInput, Intent>），
// 调用方在装配层用真实 chat model 构造；图内只做 invoke。
export type IntentClassifier = Runnable<BaseLanguageModelInput, Intent>

export interface RoutingComputePorts {
  readonly classifier: IntentClassifier
  readonly runBranch: (
    branch: BranchName,
    input: string,
    config: LangGraphRunnableConfig | undefined,
  ) => Promise<string>
  readonly synthesize: (
    input: string,
    results: readonly BranchResult[],
    config: LangGraphRunnableConfig | undefined,
  ) => Promise<string>
}

export interface RoutingGraphCompileOptions {
  /** 注入 BaseCheckpointSaver（如 PrismaCheckpointSaver）即获 checkpoint/interrupt/resume 全语义。 */
  readonly checkpointer?: BaseCheckpointSaver
}

export interface RoutingGraphInvokeOptions {
  readonly signal?: AbortSignal
  /** 阶段进度上报（SSE 接线面；同 autofigure onStage 先例——分支内 stage 事件经 configurable 出图）。 */
  readonly onStage?: (stage: string) => void
  /** true → methodGate 节点 interrupt 演示（生产默认 false，interrupt 面归审批漏斗 #783）。 */
  readonly confirmRoute?: boolean
}

export interface RoutingGraphResult {
  readonly answer: string
  readonly intent: Intent | undefined
  readonly branchResults: BranchResult[]
}

// RunService 消费面镜像（graphFactory.ts DeepAgentLike 先例）：内核只依赖 streamEvents/getState。
export interface RoutingGraphCompiledLike {
  streamEvents(input: unknown, options: object): Promise<AsyncIterable<unknown>>
  getState(config: unknown): Promise<unknown>
}

export interface RoutingGraph {
  readonly agent: RoutingGraphCompiledLike
  invoke(init: { input: string }, options?: RoutingGraphInvokeOptions): Promise<RoutingGraphResult>
}

// ---------------------------------------------------------------------------
// 图工厂（纯函数：同 ports/compileOptions 必同拓扑）
// ---------------------------------------------------------------------------

export function createRoutingGraph(
  ports: RoutingComputePorts,
  compileOptions?: RoutingGraphCompileOptions,
): RoutingGraph {
  function stage(config: LangGraphRunnableConfig | undefined, name: string): void {
    const onStage = config?.configurable?.onStage as ((stage: string) => void) | undefined
    onStage?.(name)
  }

  // 节点 1：意图分类。结构化输出（label+confidence）经端口分类器；Command 回写状态（update
  // 不带 goto —— 路由交给 addConditionalEdges，Command 与条件边两种形态在本图同时可见）。
  async function classifyNode(
    state: RoutingState,
    config: LangGraphRunnableConfig | undefined,
  ): Promise<Command> {
    stage(config, 'classifying')
    const intent = await ports.classifier.invoke(state.input)
    return new Command({ update: { intent } })
  }

  // 条件边 path 函数：纯状态派生（state.intent → 分支名），返回值经 pathMap 解析为节点。
  // 兜底 'literature'：分类器输出被 schema 钉死四值，default 分支仅防御端口实现漂移。
  function routeByIntent(state: RoutingState): BranchName {
    return state.intent?.label ?? 'literature'
  }

  // method 分支前置闸（interrupt/resume 演示面）：confirmRoute 未开 = 透明通过；
  // 开启 = interrupt 挂起，resume 值回灌——proceed 放行，否则 Command 跳 END（answer 直写）。
  function methodGateNode(
    state: RoutingState,
    config: LangGraphRunnableConfig | undefined,
  ): Partial<RoutingState> | Command {
    if (config?.configurable?.confirmRoute !== true) return {}
    const decision = interrupt<{ kind: 'route-confirm'; intent: Intent }, { proceed: boolean }>({
      kind: 'route-confirm',
      intent: state.intent!, // classify 先于本节点，intent 必已落状态
    })
    if (decision.proceed) return {}
    return new Command({ update: { answer: '[method branch cancelled by gate]' }, goto: END })
  }

  function makeBranchNode(branch: BranchName) {
    return async function branchNode(
      state: RoutingState,
      config: LangGraphRunnableConfig | undefined,
    ): Promise<Partial<RoutingState>> {
      stage(config, `branch:${branch}`)
      const output = await ports.runBranch(branch, state.input, config)
      return { branchResults: [{ branch, output }] }
    }
  }

  async function synthesizeNode(
    state: RoutingState,
    config: LangGraphRunnableConfig | undefined,
  ): Promise<Partial<RoutingState>> {
    stage(config, 'synthesizing')
    const answer = await ports.synthesize(state.input, state.branchResults, config)
    return { answer }
  }

  const workflow = new StateGraph({ stateSchema: Annotation.Root(RoutingAnnotation) })
    .addNode('classify', classifyNode)
    .addNode('literature', makeBranchNode('literature'))
    .addNode('data', makeBranchNode('data'))
    .addNode('methodGate', methodGateNode)
    .addNode('method', makeBranchNode('method'))
    .addNode('writing', makeBranchNode('writing'))
    .addNode('synthesize', synthesizeNode)
    .addEdge(START, 'classify')
    .addConditionalEdges('classify', routeByIntent, {
      literature: 'literature',
      data: 'data',
      method: 'methodGate',
      writing: 'writing',
    })
    .addEdge('methodGate', 'method')
    .addEdge('literature', 'synthesize')
    .addEdge('data', 'synthesize')
    .addEdge('method', 'synthesize')
    .addEdge('writing', 'synthesize')
    .addEdge('synthesize', END)

  const compiled = workflow.compile({
    ...(compileOptions?.checkpointer ? { checkpointer: compileOptions.checkpointer } : {}),
  })

  return {
    agent: compiled as unknown as RoutingGraphCompiledLike,
    async invoke(init, options) {
      const state = await compiled.invoke(
        { input: init.input },
        {
          ...(options?.signal ? { signal: options.signal } : {}),
          configurable: {
            onStage: options?.onStage,
            confirmRoute: options?.confirmRoute === true,
          },
        },
      )
      if (state.answer === undefined) {
        // 拓扑终局必有 answer（synthesize 直写或 gate 取消直写）——理论不可达的防御面。
        throw new Error('routing graph finished without answer')
      }
      return { answer: state.answer, intent: state.intent, branchResults: state.branchResults }
    },
  }
}
