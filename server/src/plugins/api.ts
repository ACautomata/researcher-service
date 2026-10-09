// 插件契约类型出口（#752 §1/§2 · #788）：definePlugin 与全部 server 面 类型。
// 插件 manifest 经相对别名（@server/plugins/api）或相对路径 import 本文件。
//
// 形状纪律（R2）：manifest 是纯数据声明——无 factory 动态性、无运行时加载；工具 execute /
// 命令 handler 是 manifest 内的具名函数字段，注册期静态可校验（§2.2/§2.3）。

import type { z } from 'zod'

// ---------------------------------------------------------------------------
// 工具注册（§2.2）
// ---------------------------------------------------------------------------

// 类别 = 审批漏斗路由键（§3）：file → pathParams 过路径白名单；exec → 命令黑名单；
// domain → 不进漏斗。核心拒绝未声明类别的工具（根决策 Q11）。
export type PluginToolCategory = 'file' | 'exec' | 'domain'

// ---------------------------------------------------------------------------
// ctx 四件（#744 §11.1 · #792）：随首个消费者（figure）校准的副作用服务句柄面。
// 全是副作用端口（DB/LLM/审计/装配身份）——可测接缝，插件内纯逻辑零接缝直写；
// figure 域触核心只经此四件（#752 §2.2 推荐接缝）。
// ---------------------------------------------------------------------------

// run 装配身份（#744 §11.1）：execute 签名无身份参数——身份面单点经 ctx 进，
// 防插件隐式抓全局。sessionId = parentSessionId ?? sessionId（teammate 溯源挂 parent）。
export interface PluginRunIdentity {
  readonly ownerId: string
  readonly sessionId: string
  readonly runId: string
}

// figures 落库面（核心 server/src/figures 实现）：终态一次性 create——GenerationJob 退役后
// Figure 无状态列，单写方法即全写面。幂等（同 toolCallId 不重复建行）由核心实现按调用方
// run 的 toolCallId 承载（figures 数据面不加列，#744 §5.3）。
export interface PluginFigureCreateInput {
  readonly prompt: string // method_text
  readonly svg: string // final SVG 文本
  readonly pngBytes?: Uint8Array // 预览 PNG（渲染失败不致命 → 缺省 + meta 标记）
  readonly meta: unknown // EvaluationMeta（pipeline 元数据，JSON 序列化落 evaluation 列）
  readonly sessionId: string // 溯源列（§5.1）
}

export interface PluginFiguresPort {
  readonly create: (input: PluginFigureCreateInput) => Promise<{ readonly figureId: string }>
}

// 核心 ProviderRegistry 出口的高层句柄：owner 无 provider → 面板默认 → 明确报错的回退链
// 封装在核心实现内，插件不碰 registry 查询逻辑（#744 §6）。文本与 PNG 图混合序列。
export type PluginLlmContent = string | { readonly png: Uint8Array }

export interface PluginLlmCallOptions {
  readonly maxTokens: number
  readonly temperature: number
}

export interface PluginLlmResult {
  readonly text: string
  readonly usage?: PluginToolUsage
}

export interface PluginLlmPort {
  readonly generateMultimodal: (opts: {
    readonly contents: readonly PluginLlmContent[]
    readonly model: string // provider 集合内模型 id；空串 = 默认链 primary 不绑模型
  } & PluginLlmCallOptions) => Promise<PluginLlmResult>
}

// figure_run 审计事件（#744 §11.2 形状定稿——TextTrace 弱关联，traceId 关联会话 run）。
// created/stage_transitions/completed/failed/aborted 五类落审计域；progress 的 SSE 面
// 归 runner onUpdate 翻译链（同一阶段变化事实双面，onUpdate 上报一次 runner 落两面）。
// detail 为域载荷（stage/figureId/reason/by/iterations/durationMs…）——stage 白名单
// 校验归 runner 面，端口不锁 figure 域类型。
export type FigureRunAuditKind = 'created' | 'stage_transitions' | 'completed' | 'failed' | 'aborted'

export interface FigureRunAuditEvent {
  readonly event: FigureRunAuditKind
  readonly toolCallId: string
  readonly detail: Readonly<Record<string, unknown>>
}

export interface PluginAuditPort {
  readonly emitFigureRun: (event: FigureRunAuditEvent) => void
}

// 插件工具运行上下文（§2.2 ctx 最小面）：config = configSchema 声明键的解析值（启动期
// 校验后注入）；logger = 面板统一日志面。不给直连口：fsPort / 沙箱 exec / 凭证面。
// 四件（run/figures/llm/audit）= run 装配面注入——agent 路径经 run frame ALS、直达路径
// 显式构造；frame 缺失（注册期探针/无 runner 上下文）为 undefined，域工具执行时自校验。
export interface PluginToolContext {
  readonly config: Readonly<Record<string, string>>
  readonly logger: { readonly info: (message: string) => void; readonly warn: (message: string) => void }
  readonly run?: PluginRunIdentity
  readonly figures?: PluginFiguresPort
  readonly llm?: PluginLlmPort
  readonly audit?: PluginAuditPort
}

// 给模型/审计的内容块（#751 双面：content 是结论性事实唯一来源——R6 事实同源不变量）。
export type PluginToolContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } }

// 嵌套 LLM 调用 usage 并入口径（审计面；V1 形状随 #753 首个消费者校准）。
export interface PluginToolUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
}

export interface PluginToolResult<TDetails = unknown> {
  /** 给模型 + 审计；大结果截断并在 content 指引读全文（截断面 ≤1k，与 projector 同纪律）。 */
  readonly content: readonly PluginToolContentBlock[]
  /** 仅渲染/状态重建，不进模型上下文；undefined 合法（≤4KB 截断面，§2.4）。 */
  readonly details?: TDetails
  /** 嵌套 LLM 调用 usage 须并入会话总量（审计口径）。 */
  readonly usage?: PluginToolUsage
}

export interface PluginToolExec {
  /** run abort 传播（#726 abort 语义）；run 中止时 aborted。 */
  readonly signal: AbortSignal
  /** 部分结果上报（onUpdate 收录进签名；通用 SSE 进度事件 = V2，§6）。 */
  readonly onUpdate?: (partial: unknown) => void
  readonly ctx: PluginToolContext
}

export interface PluginToolDefinition<TParams = unknown, TDetails = unknown> {
  /** LLM 工具调用名；全局唯一（核心 + 跨插件），注册期校验。 */
  readonly name: string
  /** 给 LLM 的工具描述。 */
  readonly description: string
  /** 必填——核心拒绝未声明类别的工具（根决策 Q11）。 */
  readonly category: PluginToolCategory
  /** file 类必填：路径参数名清单，漏斗规则层校验目标（§3）。 */
  readonly pathParams?: readonly string[]
  /** zod 参数 schema（项目校验纪律；LangChain 工具面等价 JSON schema）。 */
  readonly parameters: z.ZodType<TParams>
  /** 一行摘要，runner 组装系统 prompt 的插件段；不提供则该段省略该工具。 */
  readonly promptSnippet?: string
  /** 工具激活时追加进 prompt Guidelines 段的 bullet。 */
  readonly promptGuidelines?: readonly string[]
  readonly execute: (toolCallId: string, params: TParams, exec: PluginToolExec) => Promise<PluginToolResult<TDetails>>
}

// manifest 数组的异构宽化形态（各工具 TParams/TDetails 不同——数组装配处统一擦除）。
/** eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type AnyPluginToolDefinition = PluginToolDefinition<any, any>

// ---------------------------------------------------------------------------
// 命令注册（§2.3）
// ---------------------------------------------------------------------------

// 两类 outcome（R9）：inject = 以 user message 注入会话（#742 官方命令同形，agent 可追问）；
// execute = 直达本插件工具执行面（不经 agent 自由裁量——两条触发面一条执行面，#744）。
export type PluginCommandOutcome = { readonly inject: string } | { readonly execute: { readonly tool: string; readonly args: unknown } }

export interface PluginCommandContext {
  readonly logger: { readonly info: (message: string) => void; readonly warn: (message: string) => void }
}

export interface AutocompleteItem {
  readonly value: string
  readonly description?: string
}

export interface PluginCommandDefinition {
  /** 不含斜杠；保留字命名空间（R4：系统含官方目录 > 插件，无遮蔽）。 */
  readonly name: string
  readonly description?: string
  /** 参数级补全（#751 收录）：经 REST 按需调用（debounce）。 */
  readonly getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | Promise<AutocompleteItem[]>
  readonly handler: (args: string, ctx: PluginCommandContext) => Promise<PluginCommandOutcome>
}

// ---------------------------------------------------------------------------
// manifest 总形（§2.1）与 configSchema（§5）
// ---------------------------------------------------------------------------

export interface PluginEnvKey {
  /** env 键名（大写蛇形）。 */
  readonly name: string
  /** 缺省可选；required 缺失 = 启动期 prod fail-fast / dev 警告的判定依据（R7）。 */
  readonly required?: boolean
  readonly description?: string
  /** 废弃标记（#883）：设值时启动期 warn（键仍生效——退役由后续票收口）。 */
  readonly deprecated?: boolean
}

// LLM 需求声明位（#883 T3 · #752 §5 V2 per-user 配置提前）：声明即出现在 ModelView
// 插件指派区，用户可 per-user 指派「端点 + 模型」（缺省跟随默认链）。声明是纯目录
// 元数据——运行时解析链在核心 ctx.llm resolver（runner/llmToolPort），本位不承载行为。
export interface PluginLlmDeclaration {
  /** 指派 UI 的用途描述（一行）。 */
  readonly description: string
  /** 可选默认模型建议（指派 UI 预填参考；非运行时解析面）。 */
  readonly defaultModel?: string
}

export interface PluginManifest {
  /** kebab-case，与目录名一致，全局唯一。 */
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version: string
  readonly tools?: readonly AnyPluginToolDefinition[]
  readonly commands?: readonly PluginCommandDefinition[]
  /** V1 语义 = 启动校验依据 + 文档（§5）；ctx.config 按声明键注入解析值。 */
  readonly configSchema?: { readonly env: readonly PluginEnvKey[] }
  /** LLM 需求声明位（#883）：声明 = 可被 per-user 指派端点与模型；未声明插件的指派写侧拒绝。 */
  readonly llm?: PluginLlmDeclaration
}

export function definePlugin(manifest: PluginManifest): PluginManifest {
  return manifest
}
