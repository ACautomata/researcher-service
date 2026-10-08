// models 域常量（#881 预设制换形后精简）：协议二值 + provider_id 校验 + 模型条目模态枚举。
//
// 术语对齐：provider_id = 端点行的稳定 id（用户命名域，DNS-label 风格）；保留域 'platform'
// （平台虚拟条目，presets.ts RESERVED_PROVIDER_IDS）。preset_id ∈ 端点预设清单（presets.ts
// 单一来源）——协议/baseUrl/凭证头策略全部随预设派生，无自由地址。
//
// wire 命名：REST 请求/响应体沿用 snake_case（provider_id / preset_id / api_key / …），
// 与整个 Express server 既有 wire 契约一致；Prisma 模型字段为 camelCase。

// provider_id 小写 DNS-label 风格（r28 §1）：1–64 位
export const PROVIDER_ID_REGEX = /^[a-z][a-z0-9-]{0,63}$/

// 协议二值（wire 命名；预设派生只读，写侧不收）
export const API_CHOICES = ['openai-completions', 'anthropic-messages'] as const
export type ProviderApiWire = (typeof API_CHOICES)[number]

// 模型 input 模态枚举（r28 §1.2 权威列举）：入站校验闸——非法值入库则消费端拒绝、
// 运行时落后 DB（入站拒，落库形状才可能合法）。
export const MODEL_INPUT_MODALITIES = ['text', 'image', 'audio', 'video', 'pdf'] as const
export type ModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number]
