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

// 预设默认模型条目（ModelEntryLike 形状子集——id 必填，其余展示元数据；成本数字不确者不编造）。
export interface PresetModelEntry {
  readonly id: string
  readonly name?: string
  readonly reasoning?: boolean
  readonly input?: readonly string[]
  readonly cost?: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }
  readonly contextWindow?: number
  readonly maxTokens?: number
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
    defaultModels: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', reasoning: true, input: ['text', 'image'] }],
  }),
  freezePreset({
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    authHeader: true,
    defaultModels: [{ id: 'gpt-5.1', name: 'GPT-5.1', reasoning: true, input: ['text', 'image'] }],
  }),
  freezePreset({
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai-completions',
    baseUrl: 'https://api.deepseek.com',
    authHeader: true,
    // V4-Flash（docs/research/deepseek-v4-flash-api.md：唯一 id、text-only、1M 上下文）
    defaultModels: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', input: ['text'], contextWindow: 1048576, maxTokens: 393216 }],
  }),
  freezePreset({
    id: 'kimi',
    name: 'Kimi（月之暗面）',
    protocol: 'openai-completions',
    baseUrl: 'https://api.moonshot.cn/v1/', // 尾斜杠逐字锁定
    authHeader: true,
    defaultModels: [{ id: 'kimi-k2', name: 'Kimi K2', input: ['text'] }],
  }),
  freezePreset({
    id: 'zhipu',
    name: '智谱 GLM',
    protocol: 'openai-completions',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', // 不带尾斜杠（逐字锁定）
    authHeader: true,
    defaultModels: [{ id: 'glm-4.6', name: 'GLM-4.6', reasoning: true, input: ['text'] }],
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
