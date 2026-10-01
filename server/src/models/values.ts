// models 域常量 + wire↔DB 枚举映射（平移 backend/models/models.py，#336）。
//
// 术语对齐：provider_id = openclaw.json models.providers 的 map key（r28 §1：minimax / vllm /
// my-proxy），亦拼成 <pid>/<mid> 引用进 agents.defaults.model —— 须小写 DNS-label 风格，禁路径
// 分隔符 / 大写 / 数字开头。api_key_env_id = SecretRef.id（env 变量名），须 ^[A-Z][A-Z0-9_]{0,127}$，
// 且须为容器已注入的 env（ALLOWED_API_KEY_ENV_IDS）。
//
// wire 命名：REST 请求/响应体沿用 Django/frontend 的 snake_case（provider_id / base_url /
// api_key_env_id / auth_header / created_at），与整个 Express server 既有 wire 契约一致；
// Prisma 模型字段为 camelCase（providerId / credentialEnvId / …）。字段级 snake↔camel 映射在各层
// 入口/出口收敛（routes.toInput / service.toView·toSpec），enum 的 wire↔DB 映射在本文件收敛。
//
// #771（731 §2.1/§3.2）：DB 枚举列 api（openai_completions/anthropic_messages）改造为 lcProvider
// 二值白名单（openai/anthropic）——1:1 映射（openai-completions→openai / anthropic-messages→
// anthropic，OpenAI 兼容端点统一走 openai + baseUrl）；wire 取值集不变，映射在本文件收敛。

import type { LcProvider } from '../generated/prisma/client'

// provider_id 小写 DNS-label 风格（r28 §1）：1–64 位
export const PROVIDER_ID_REGEX = /^[a-z][a-z0-9-]{0,63}$/

// apiKey env id：大写字母开头，仅含大写字母、数字、下划线（1–128 位）
export const API_KEY_ENV_ID_REGEX = /^[A-Z][A-Z0-9_]{0,127}$/

// r28 §1.3：CRUD 表单只暴露这两个稳定取值（避免低置信别名）
export const API_CHOICES = ['openai-completions', 'anthropic-messages'] as const
export type ProviderApiWire = (typeof API_CHOICES)[number]

// 凭证 env id 白名单（过渡态，#775）：SecretRef 机制随 OpenClaw 写盘链退役（731 §1.3——runner
// 直接持有凭证，env id 的「容器 env 固定」存在理由消失），但 runner 侧凭证解析
// （providerRegistry.resolveApiKey）当前仅注入 LLM_API_KEY，API 层据此收紧；P1 per-user key
// （credentialCipher）落地时放宽或退役本集合。
export const ALLOWED_API_KEY_ENV_IDS: ReadonlySet<string> = new Set(['LLM_API_KEY'])

// 模型 input 模态枚举（r28 §1.2 / `/gateway/config-agents` 权威列举）：入站校验闸。
// 非法值（如 "bogus"）经 builder 原样透传落盘 → OpenClaw 热加载校验拒绝 → 运行时落后 DB（#366
// codex 四轮 P2：z.array(z.string()) 只验容器类型、不验取值）。
export const MODEL_INPUT_MODALITIES = ['text', 'image', 'audio', 'video', 'pdf'] as const
export type ModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number]

// wire（连字符真值，落盘 openclaw.json）↔ lcProvider 二值白名单（Prisma enum，#771 / 731 §2.1）。
export const WIRE_TO_LC_PROVIDER: Record<ProviderApiWire, LcProvider> = {
  'openai-completions': 'openai',
  'anthropic-messages': 'anthropic',
}
export const LC_PROVIDER_TO_WIRE: Record<LcProvider, ProviderApiWire> = {
  openai: 'openai-completions',
  anthropic: 'anthropic-messages',
}

// 防御解码 modelsJson（对齐 containers.decodeScopes）：坏 JSON 让读请求 500；合法 JSON 但非数组
// 也违反 models[] 响应契约 → 回退 []。service（读侧视图）与 runner/providerRegistry（配置快照）
// 共用（#775）。
export function decodeModelsJson(raw: string): Array<Record<string, unknown>> {
  try {
    const v: unknown = JSON.parse(raw)
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>
  } catch {
    // 坏 JSON → 回退 []
  }
  return []
}
