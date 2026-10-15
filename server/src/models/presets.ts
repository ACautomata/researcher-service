// 端点预设清单（#881）：LLM 端点的唯一取值域——六预设代码常量，无自由 baseURL
//（SSRF 构造性消灭：BYOK 端点只能从本清单选，协议与地址随预设锁定）。加预设 = 改代码发版，
// 随版评审（#880 Implementation Decisions）。
//
// 消费面（漂移守卫 modelsPresets.test.ts 钉两侧一致）：
//   ① REST 目录下发（GET /api/v1/models/presets——前端建端点下拉）
//   ② v16 收敛迁移 host 归一映射——scripts/lib/incremental-schema.mjs 内联同规则表
//     V16_HOST_TO_PRESET（mjs 无法 import TS，运行时并不消费本文件；下方 PRESET_HOST_TO_ID
//     导出仅供漂移守卫测试对照，防两侧规则漂移）
//   ③ config LLM_PRESET 校验（六选一，缺省 minimax）
//
// URL 逐字锁定（kimi 带尾斜杠、zhipu 不带——各家 OpenAI 兼容面的既有惯例，勿「规范化」）：
// 平台默认端点（env 派生虚拟实体，不落库）经 LLM_PRESET 从本清单取协议/地址/默认模型。

// 协议二值（wire 命名；values.ts 侧的同名常量已随 #881 预设制删除，此处为唯一来源）。
export type EndpointProtocol = 'anthropic-messages' | 'openai-completions'

// 推理强度能力三值（ADR 0020 决策 2）：native = 三档原生生可调；thinking-only = 仅思考开关
//（三档降两档：简洁=思考关、标准/深思=思考开）；none = 无通道（写侧拒 effort、UI 置灰）。
export type EffortCapability = 'native' | 'thinking-only' | 'none'

// 预设默认模型条目（ModelEntryLike 形状子集——id 必填，其余展示元数据；成本数字不确者不编造）。
export interface PresetModelEntry {
  readonly id: string
  readonly name?: string
  readonly reasoning?: boolean
  readonly input?: readonly string[]
  readonly cost?: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }
  readonly contextWindow?: number
  readonly maxTokens?: number
  // 推理强度能力（ADR 0020 per-model 映射表，#978 起）：三值 native | thinking-only | none
  // + 映射注记（GET /models/available 与写侧 super-refine 的单源）。六预设逐条显式声明
  //（deepseek 1:1 / anthropic·openai 就近映射 / minimax·glm thinking-only / kimi none）——
  // 既有 `reasoning` 布尔只表达「有思考面」展示元数据，区分不了 native 与 thinking-only，
  // 不作派生源。
  readonly effortCapability?: EffortCapability
  readonly effortNote?: string
}

export interface EndpointPreset {
  readonly id: string
  readonly name: string
  readonly protocol: EndpointProtocol
  readonly baseUrl: string
  /** anthropic 协议面凭证头策略：true = 强制 Authorization: Bearer（兼容面）；false = SDK 原生（x-api-key）。 */
  readonly authHeader: boolean
  readonly defaultModels: readonly PresetModelEntry[]
}

function freezePreset(p: EndpointPreset): EndpointPreset {
  return Object.freeze({ ...p, defaultModels: Object.freeze(p.defaultModels.map((m) => Object.freeze({ ...m }))) })
}

// MiniMax-M3 模型条目（providerDefaults 既有真值原样平移——cost/contextWindow 沿用）。
const MINIMAX_M3: PresetModelEntry = {
  id: 'MiniMax-M3',
  name: 'MiniMax M3',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
  contextWindow: 1048576,
  maxTokens: 524288,
  // ADR 0020：仅 thinking 开关——三档降两档（简洁=思考关、标准/深思=思考开）。
  effortCapability: 'thinking-only',
  effortNote: '标准 · 深思＝开（简洁＝思考关）',
}

export const ENDPOINT_PRESETS: readonly EndpointPreset[] = Object.freeze([
  freezePreset({
    id: 'minimax',
    name: 'MiniMax（平台默认）',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    authHeader: true, // MiniMax anthropic 兼容面通行 Bearer（repo 调研文档锁）
    defaultModels: [MINIMAX_M3],
  }),
  freezePreset({
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    authHeader: false, // 官方原生 x-api-key 头
    defaultModels: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', reasoning: true, input: ['text', 'image'], effortCapability: 'native', effortNote: '三档就近映射 Anthropic effort 五档' }],
  }),
  freezePreset({
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    authHeader: true,
    defaultModels: [{ id: 'gpt-5.1', name: 'GPT-5.1', reasoning: true, input: ['text', 'image'], effortCapability: 'native', effortNote: '三档就近映射 OpenAI reasoning effort 七值' }],
  }),
  freezePreset({
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai-completions',
    baseUrl: 'https://api.deepseek.com',
    authHeader: true,
    // V4-Flash（docs/research/deepseek-v4-flash-api.md：唯一 id、text-only、1M 上下文）。
    // #978 补齐派生源：三档 `reasoning_effort` 1:1 直传（ADR 0020）——显式 native，不靠缺省。
    defaultModels: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', input: ['text'], contextWindow: 1048576, maxTokens: 393216, effortCapability: 'native', effortNote: '三档 1:1 直传' }],
  }),
  freezePreset({
    id: 'kimi',
    name: 'Kimi（月之暗面）',
    protocol: 'openai-completions',
    baseUrl: 'https://api.moonshot.cn/v1/', // 尾斜杠逐字锁定
    authHeader: true,
    defaultModels: [{ id: 'kimi-k2', name: 'Kimi K2', input: ['text'], effortCapability: 'none', effortNote: '该模型无推理强度通道' }],
  }),
  freezePreset({
    id: 'zhipu',
    name: '智谱 GLM',
    protocol: 'openai-completions',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', // 不带尾斜杠（逐字锁定）
    authHeader: true,
    defaultModels: [{ id: 'glm-4.6', name: 'GLM-4.6', reasoning: true, input: ['text'], effortCapability: 'thinking-only', effortNote: '标准 · 深思＝开（简洁＝思考关）' }],
  }),
])

export const PRESET_IDS: readonly string[] = ENDPOINT_PRESETS.map((p) => p.id)

export function presetById(id: string): EndpointPreset | undefined {
  return ENDPOINT_PRESETS.find((p) => p.id === id)
}

// wire 协议 → LangChain provider 二值（对齐 models/values.ts 映射语义）。
export function protocolToLcProvider(protocol: EndpointProtocol): 'openai' | 'anthropic' {
  return protocol === 'anthropic-messages' ? 'anthropic' : 'openai'
}

// v16 收敛迁移的 host→preset 归一映射（从 baseUrl 派生，漂移守卫锁定同源）。
export const PRESET_HOST_TO_ID: ReadonlyMap<string, string> = new Map(
  ENDPOINT_PRESETS.map((p) => [new URL(p.baseUrl).hostname, p.id]),
)

// 平台默认端点的 providerId（env 派生虚拟实体，不落库；插件指派 'platform'=钉平台同键）。
export const PLATFORM_PROVIDER_ID = 'platform'

// BYOK 端点 providerId 保留域：用户行不得抢注平台 id（写侧拒绝）。
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set([PLATFORM_PROVIDER_ID])

// 平台默认端点模型条目集（#883/#880 review 收敛单一来源）：LLM_MODEL 覆盖 = 单条裸 id
//（覆盖值无预设元数据），否则预设 defaultModels 全集原样。指派写侧取值域、快照平台条目、
// REST /platform 下发三面同源同规则。
export function platformModels(llmModel: string, llmPreset: string): readonly PresetModelEntry[] {
  const preset = presetById(llmPreset) ?? presetById('minimax')!
  return llmModel !== '' ? [{ id: llmModel }] : preset.defaultModels
}

export function platformModelIds(llmModel: string, llmPreset: string): string[] {
  return platformModels(llmModel, llmPreset).map((m) => m.id)
}

// ---------------------------------------------------------------------------
// 推理强度能力表（ADR 0020 per-model 映射表唯一来源；#978）
// ---------------------------------------------------------------------------

// 无逐模型元数据条目的缺省能力（ADR 0020 决策 2 裁定 native，已否决默认 none）：BYOK 第三方
// 模型 / 平台 LLM_MODEL 覆盖裸 id 等查表未命中者一律 native；effort 注入走 modelKwargs
//（票②注入面），调用报错由用户回退「标准」自愈。
export const DEFAULT_EFFORT_CAPABILITY: EffortCapabilityMeta = Object.freeze({
  capability: 'native',
  effortNote: '经 modelKwargs 注入（第三方兼容面）',
})

export interface EffortCapabilityMeta {
  readonly capability: EffortCapability
  readonly effortNote: string
}

// modelId → 能力元数据（六预设 defaultModels 逐条 effortCapability 声明摊平；声明条目 id 跨
// 预设唯一由 modelsPresets 漂移守卫测试钉住——Map 后写覆盖是静默面，靠测试防漂移）。
export const EFFORT_CAPABILITY_BY_MODEL_ID: ReadonlyMap<string, EffortCapabilityMeta> = new Map(
  ENDPOINT_PRESETS.flatMap((p) =>
    p.defaultModels
      .filter((m): m is PresetModelEntry & { effortCapability: EffortCapability; effortNote: string } =>
        m.effortCapability !== undefined && m.effortNote !== undefined)
      .map((m) => [m.id, Object.freeze({ capability: m.effortCapability, effortNote: m.effortNote }) as EffortCapabilityMeta]),
  ),
)

// 查表未命中 → 缺省 native + modelKwargs 注记（不区分 provider——能力是模型属性，与端点
// 无关；BYOK kimi 行上的 kimi-k2 与平台 kimi 同样 none）。
export function effortCapabilityOf(modelId: string): EffortCapabilityMeta {
  return EFFORT_CAPABILITY_BY_MODEL_ID.get(modelId) ?? DEFAULT_EFFORT_CAPABILITY
}

// ---------------------------------------------------------------------------
// 推理强度注入映射（ADR 0020 · #979 票②）：effort 规范档 → 各家绑定参数面。
// 映射单点本文件（ADR 0020 决策 2「映射单点在 presets.ts，随端点预设同版评审」）；
// 装配缝消费见 providerRegistry.getDefaultModel，通道接线见 models/chatFactory.ts。
// ---------------------------------------------------------------------------

// 规范三档存储词汇（与 validation/schemas.ts EFFORT_VALUES 同值域——彼处 zod 写侧单源，
// 此处运行层类型镜像；等值由 test/effortBinding.test.ts 漂移守卫钉住。宽松读的存量行/
// 手写脏值由 effortBindingOf 兜底为零注入）。
export type EffortTier = 'low' | 'high' | 'max'

// EffortTier 的值清单形态（EFFORT_TIERS 集合的派生源；漂移守卫与 schemas.EFFORT_VALUES 比对）。
export const EFFORT_TIER_VALUES: readonly EffortTier[] = ['low', 'high', 'max']

// 注入绑定面：ConfigurableModel withConfig({configurable}) 的合并 bag（模型实例缓存 key
// 刻意不含 effort——per-request 绑定语义不变，#979）。键 = 底层 ChatModel 一级字段名
//（openai：reasoning / modelKwargs；anthropic：outputConfig / thinking——chatFactory
// *_CONFIGURABLE_FIELDS 常量钉住可配置集，测试面漂移即红）。
export interface EffortBinding {
  readonly configurable: Readonly<Record<string, unknown>>
}

// 就近映射目标枚举（SDK 类型面锁定：@anthropic-ai/sdk OutputConfig.effort 五档 /
// openai ReasoningEffort 七值）。规范三档在两枚举中均有精确同名词 → 映射为自身；
// 显式表而非恒等函数——枚举收缩时漂移即红（ADR 0020「就近映射」的具象化）。
type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type OpenAIEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const ANTHROPIC_EFFORT_NEAREST: Readonly<Record<EffortTier, AnthropicEffort>> = Object.freeze({ low: 'low', high: 'high', max: 'max' })
const OPENAI_EFFORT_NEAREST: Readonly<Record<EffortTier, OpenAIEffort>> = Object.freeze({ low: 'low', high: 'high', max: 'max' })

// thinking-only 两态（ADR 0020 决策 2 降两档：简洁=思考关、标准/深思=思考开）。无
// budget_tokens——MiniMax-M3 anthropic 兼容面思考自适应（外部实测：手动预算契约不存在）。
const THINKING_TWO_STATE: Readonly<Record<EffortTier, { readonly type: 'disabled' | 'enabled' }>> = Object.freeze({
  low: Object.freeze({ type: 'disabled' }),
  high: Object.freeze({ type: 'enabled' }),
  max: Object.freeze({ type: 'enabled' }),
})

const EFFORT_TIERS: ReadonlySet<string> = new Set<string>(EFFORT_TIER_VALUES)

// effort 规范档 → 绑定参数面（唯一运行层入口；undefined = 零注入）：
//   - effort 缺省（存量无 effort 行）/ 越界（手写行脏值）→ undefined——运行层零注入，
//     装配产物与今日逐字节等价（ADR 0019「存量宽松接受」的运行半边）。
//   - 能力 none（kimi-k2）→ undefined——结构性零注入（#978 写侧 90002 已拦，运行层双保险）。
//   - 未命中元数据（BYOK 第三方 / 平台 LLM_MODEL 覆盖裸 id）→ 缺省 native，通道随协议面
//     face：openai 兼容面 modelKwargs reasoning_effort 直传（多数 openai 兼容推理模型）；
//     anthropic 面 outputConfig.effort（该面唯一 effort 通道——ChatAnthropic 无 modelKwargs
//     字段，发 modelKwargs 会在 ConfigurableField 白名单过滤层静默丢弃 = 假注入；不支持的
//     兼容端点报错由用户回退滑块自愈，ADR 0020 决策 2「调用报错自愈」语义）。
// face 必填（无缺省值）：已知六预设的 face 由映射表 case 面自身决定，此处参数只服务缺省
// native 分支——显式传入防「忘传即在 openai 语义上注入 anthropic 端点」的静默错配复发。
export function effortBindingOf(modelId: string, effort: EffortTier | undefined, face: 'openai' | 'anthropic'): EffortBinding | undefined {
  if (effort === undefined || !EFFORT_TIERS.has(effort)) return undefined
  if (effortCapabilityOf(modelId).capability === 'none') return undefined
  switch (modelId) {
    case 'deepseek-v4-flash':
      // 三档 1:1 直传。isReasoningModel 前缀门只认 o*/gpt-5*/gpt-6*——一级 reasoning 通道
      // 被挡（B1 硬坑①），经 modelKwargs 直入请求体（wire 同形 reasoning_effort）。
      return { configurable: { modelKwargs: { reasoning_effort: effort } } }
    case 'claude-sonnet-5-5':
      // ChatAnthropic 一级 outputConfig 通道（→ wire output_config.effort，五档就近映射）
      return { configurable: { outputConfig: { effort: ANTHROPIC_EFFORT_NEAREST[effort] } } }
    case 'gpt-5.1':
      // gpt-5* 命中前缀门 → ChatOpenAI 一级 reasoning 通道（→ wire reasoning_effort，七值就近映射）
      return { configurable: { reasoning: { effort: OPENAI_EFFORT_NEAREST[effort] } } }
    case 'MiniMax-M3':
      // ChatAnthropic 一级 thinking 通道——仅显式设置才入 payload（零注入基线字节等价的根由）
      return { configurable: { thinking: THINKING_TWO_STATE[effort] } }
    case 'glm-4.6':
      // zhipu OpenAI 兼容面 body 参数 thinking 两态（ChatOpenAI 无此一级字段 → modelKwargs）
      return { configurable: { modelKwargs: { thinking: THINKING_TWO_STATE[effort] } } }
    default:
      return face === 'anthropic'
        ? { configurable: { outputConfig: { effort: ANTHROPIC_EFFORT_NEAREST[effort] } } }
        : { configurable: { modelKwargs: { reasoning_effort: effort } } }
  }
}
