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
  // 结构化生成（#853 §3.2#3）：withStructuredOutput 语义封装在核心——owner 回退链（pin >
  // 指派 > 默认链，与 generateMultimodal 同一解析）+ 配置集合第二层复验 + 文本 JSON 提取
  // + zod 校验，返回校验产物。解析/校验失败抛 PluginLlmStructuredError（诊断面透出——
  // 853 §7.1 节点层重试 prompt 附诊断回喂）。签名不出现 signal：run abort 经 frame 闭包
  // 捕获自动透传（#853 §3.2#4，插件零感知）。
  readonly generateStructured: <T>(opts: {
    readonly schema: z.ZodType<T>
    readonly contents: readonly PluginLlmContent[]
    readonly model?: string // 缺省 = 默认链 primary；非空 = pin 语义（同 generateMultimodal）
    readonly maxTokens?: number
    readonly temperature?: number // 缺省 0（结构化判定的确定性优先，judge 温度 0 先例）
  }) => Promise<T>
}

// generateStructured 解析/校验失败（#853 §3.2#3 · #906 修订①）：diagnostics = zod issues
// 或 JSON 提取失败的诊断文本，供节点层重试 prompt 回喂（PAGE_GENERATE_MAX_RETRIES 触发面
// = 截断 ∨ 结构化解析/validate 失败）；raw = 原始模型文本（截断保留，供调用方诊断日志）。
export class PluginLlmStructuredError extends Error {
  constructor(
    message: string,
    readonly diagnostics: string,
    readonly raw?: string,
  ) {
    super(message)
    this.name = 'PluginLlmStructuredError'
  }
}

// 插件 run 审计事件（#744 §11.2 形状定稿 · #853 §3.2#5 泛化——TextTrace 弱关联，traceId
// 关联会话 run）。created/stage_transitions/completed/failed/aborted 五类同构保留落审计域；
// progress 的 SSE 面归 runner onUpdate 翻译链（同一阶段变化事实双面，onUpdate 上报一次
// runner 落两面）。detail 为域载荷（stage/figureId/reason/by/iterations/durationMs…）——
// stage 白名单校验归 runner 面，端口不锁域类型。runKind 由核心按工具名反查盖章（插件不传；
// 落 TextTrace 带 runKind 列——figure 事件族为历史先例，kind 隐含 'figure'、事件面冻结
// 不落列，#853 §3.2#5）。
export type PluginRunAuditKind = 'created' | 'stage_transitions' | 'completed' | 'failed' | 'aborted'

export interface PluginRunAuditEvent {
  readonly event: PluginRunAuditKind
  readonly toolCallId: string
  readonly detail: Readonly<Record<string, unknown>>
}

export interface PluginAuditPort {
  readonly emitPluginRun: (event: PluginRunAuditEvent) => void
}

// ---------------------------------------------------------------------------
// ctx.wiki / ctx.docs（#853 §3.2#1/#2 · #908）——插件与主 agent 同通道的 wiki 检索读写口
// 与窄域 PDF 文本提取口。类型面住此；实现在 runner/wikiToolPort.ts + runner/docsToolPort.ts
//（组装纯逻辑在 wiki/pluginPage.ts）；DTO zod 在 wiki/pluginPage.ts（图内校验与 port
// 边界同构复用，单一来源）。
// ---------------------------------------------------------------------------

// PageType 枚举值集（853 §11.3C 拍板）：论文页 / critic 页 / idea-card / 实验报告。
export const PLUGIN_PAGE_TYPES = ['paper', 'critic', 'idea-card', 'experiment-report'] as const
export type PluginPageType = (typeof PLUGIN_PAGE_TYPES)[number]

// ClaimDraft：claims 结构化提交单元（#850 D3）。evidence = 资源引用串（repo:// 锚形态，
// 语义重定义见 853 §11.1）——表示归 wiki 域，插件不知道 .claims 旁车存在（防腐钉界）。
export interface PluginClaimDraft {
  readonly statement: string
  readonly evidence: readonly string[]
}

// PageDraft（#851 D6）：插件只给元数据 + 正文；frontmatter 由核心组装（853 §3.3 页格式单源），
// 插件 content 内嵌 frontmatter 已否决（格式漂移面）。
export interface PluginPageDraft {
  readonly path: string // wiki 相对路径（<group>/<page>.md）
  readonly title: string
  readonly type: PluginPageType
  readonly content: string
  readonly claims?: readonly PluginClaimDraft[]
}

// createPage 溯源补充面：workflow（四流程名）与 relatedPages（W4 报告页输入页集，#868 D2）。
// source/toolCallId 不由插件传——source = 核心按调用插件 id 盖章，toolCallId = 调用方 run 的
// 真实 tool_call_id（filejournal ALS，figures 去重身份同源），frontmatter 字段集见 853 §11.3C。
export interface PluginPageProvenance {
  readonly workflow?: string
  readonly relatedPages?: readonly string[]
}

// 检索读面与主 agent wikisearch 同封装（openwiki searchWiki/readWikiSections 直调，
// SKIP 集过滤镜像）——形状对齐 openwiki WikiSearchResults/WikiReadResponse 的结构子集。
export interface PluginWikiSearchHit {
  readonly kind: string
  readonly ref: readonly string[]
  readonly content: string
}
export interface PluginWikiSearchResponse {
  readonly results: readonly PluginWikiSearchHit[]
}
export interface PluginWikiReadSection {
  readonly section: string
  readonly content: string
}
export interface PluginWikiReadResponse {
  readonly page: string
  readonly sections: readonly PluginWikiReadSection[]
}

// PluginWikiPort（853 §3.2#1）：search/readPage 读面与主 agent 同一套检索；createPage 幂等哨兵
// （页已存在 → {created:false} 不抛错，重放窗口常态路径不进 error 通道）+ port 内 owner 级
// 进程内锁（key=(ownerId, relPath)，probe+put+渲染整体在锁内）+ ensure 容器前置 + SKIP 集
// assertNotManaged + claims 渲染与 frontmatter 组装。V1 无 updatePage/deletePage（§3.2 钉）。
export interface PluginWikiPort {
  readonly search: (
    query: string,
    opts?: { readonly paths?: readonly string[]; readonly limit?: number },
  ) => Promise<PluginWikiSearchResponse>
  readonly readPage: (page: string, sections: readonly string[]) => Promise<PluginWikiReadResponse>
  readonly createPage: (
    draft: PluginPageDraft,
    provenance?: PluginPageProvenance,
  ) => Promise<{ readonly created: boolean }>
}

// PluginDocsPort（853 §3.2#2）：extractPdfText 窄域端口——sandboxPath 强制 /lab/ 前缀白名单
// + 存在性校验（approval 同款纪律）；沙箱内 pdftotext 按页数组返回（\f 分页，PDF 全文不进
// 主上下文）；字符上限 PDF_EXTRACT_MAX_CHARS 超限明确报错不静默截断。仅此窄域端口，
// 无通用 exec/fs 透传（#752 已钉）。
export interface PluginDocsPort {
  readonly extractPdfText: (input: {
    readonly sandboxPath: string
  }) => Promise<{ readonly pages: readonly string[] }>
}

// 插件工具运行上下文（§2.2 ctx 最小面）：config = configSchema 声明键的解析值（启动期
// 校验后注入）；logger = 面板统一日志面。不给直连口：fsPort / 沙箱 exec / 凭证面。
// 六件（run/figures/llm/audit/wiki/docs）= run 装配面注入——agent 路径经 run frame ALS、
// 直达路径显式构造；frame 缺失（注册期探针/无 runner 上下文）为 undefined，域工具执行时自校验。
export interface PluginToolContext {
  readonly config: Readonly<Record<string, string>>
  readonly logger: { readonly info: (message: string) => void; readonly warn: (message: string) => void }
  readonly run?: PluginRunIdentity
  readonly figures?: PluginFiguresPort
  readonly llm?: PluginLlmPort
  readonly audit?: PluginAuditPort
  readonly wiki?: PluginWikiPort
  readonly docs?: PluginDocsPort
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
  /** 进度 stage 白名单声明（#853 §3.1/§3.2#6「插件声明、核心校验」）：onUpdate 上报经
   *  runner 翻译面按本白名单放行（命中才落 SSE progress + stage_transitions 双面，白名单
   *  外丢弃不放大）。声明值 = 流程节点名（kebab/snake/camel 小写系形态，注册期校验非空/
   *  唯一/形态）；工具声明本项 ⇒ manifest 必须声明 run.kind（SSE 事件族名派生源，fail-fast）。 */
  readonly progressStages?: readonly string[]
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
  /** run 域标识（#853 §3.1）：kind → 插件 run 事件族名按声明派生（如 'research' →
   *  `research_run.progress`）；声明 progressStages 的工具所属 manifest 必须声明（注册期
   *  fail-fast）。TextTrace 审计面 runKind 盖章同源（figure 事件族为历史先例、事件面冻结
   *  不落 runKind 列——#853 §3.2#5）。 */
  readonly run?: { readonly kind: string }
  /** V1 语义 = 启动校验依据 + 文档（§5）；ctx.config 按声明键注入解析值。 */
  readonly configSchema?: { readonly env: readonly PluginEnvKey[] }
  /** LLM 需求声明位（#883）：声明 = 可被 per-user 指派端点与模型；未声明插件的指派写侧拒绝。 */
  readonly llm?: PluginLlmDeclaration
}

export function definePlugin(manifest: PluginManifest): PluginManifest {
  return manifest
}
