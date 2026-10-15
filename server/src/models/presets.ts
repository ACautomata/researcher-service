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
