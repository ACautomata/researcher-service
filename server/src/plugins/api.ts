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

// 插件工具运行上下文（§2.2 ctx 最小面）：config = configSchema 声明键的解析值（启动期
// 校验后注入）；logger = 面板统一日志面。不给直连口：fsPort / 沙箱 exec / 凭证面。
export interface PluginToolContext {
  readonly config: Readonly<Record<string, string>>
  readonly logger: { readonly info: (message: string) => void; readonly warn: (message: string) => void }
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
}

export function definePlugin(manifest: PluginManifest): PluginManifest {
  return manifest
}
