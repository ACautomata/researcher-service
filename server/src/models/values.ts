// models 域常量 + wire↔DB 枚举映射（平移 backend/models/models.py，#336）。
//
// 术语对齐：provider_id = openclaw.json models.providers 的 map key（r28 §1：minimax / vllm /
// my-proxy），亦拼成 <pid>/<mid> 引用进 agents.defaults.model —— 须小写 DNS-label 风格，禁路径
// 分隔符 / 大写 / 数字开头。api_key_env_id = SecretRef.id（env 变量名），须 ^[A-Z][A-Z0-9_]{0,127}$，
// 且须为容器已注入的 env（ALLOWED_API_KEY_ENV_IDS）。
//
// wire 命名：REST 请求/响应体沿用 Django/frontend 的 snake_case（provider_id / base_url /
// api_key_env_id / auth_header / created_at），与整个 Express server 既有 wire 契约一致；
// Prisma 模型字段为 camelCase（providerId / apiKeyEnvId / …）。字段级 snake↔camel 映射在各层
// 入口/出口收敛（routes.toInput / service.toView·toSpec），enum 的 wire↔DB 映射在本文件收敛。

import type { ProviderApi } from '../generated/prisma/client'

// provider_id 小写 DNS-label 风格（r28 §1）：1–64 位
export const PROVIDER_ID_REGEX = /^[a-z][a-z0-9-]{0,63}$/

// apiKey env id：大写字母开头，仅含大写字母、数字、下划线（1–128 位）
export const API_KEY_ENV_ID_REGEX = /^[A-Z][A-Z0-9_]{0,127}$/

// r28 §1.3：CRUD 表单只暴露这两个稳定取值（避免低置信别名）
export const API_CHOICES = ['openai-completions', 'anthropic-messages'] as const
export type ProviderApiWire = (typeof API_CHOICES)[number]

// 容器进程实际持有的凭证 env（spec §5.2：全面板共享一个 LLM_API_KEY；DockerRuntime 仅注入它）。
// 容器 env 在 docker run 时固定，OpenClaw watch 热加载无法新增 env（#36 已证：缺 env 则 reload
// 失败停留 last-known-good）—— 故 SecretRef.id 只能引用已注入的 env。API 层据此收紧（builder
// 层仍 env-agnostic，便于未来 fleet 注入更多 env 时仅放宽本集合）。
export const ALLOWED_API_KEY_ENV_IDS: ReadonlySet<string> = new Set(['LLM_API_KEY'])

// 模型 input 模态枚举（r28 §1.2 / `/gateway/config-agents` 权威列举）：入站校验闸。
// 非法值（如 "bogus"）经 builder 原样透传落盘 → OpenClaw 热加载校验拒绝 → 运行时落后 DB（#366
// codex 四轮 P2：z.array(z.string()) 只验容器类型、不验取值）。
export const MODEL_INPUT_MODALITIES = ['text', 'image', 'audio', 'video', 'pdf'] as const
export type ModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number]

// wire（连字符真值，落盘 openclaw.json）↔ Prisma enum（下划线标识符）映射。
// Prisma enum 值须为合法标识符 → 下划线名 + @map 落连字符真值（schema 同款取向）。
export const WIRE_TO_API_ENUM: Record<ProviderApiWire, ProviderApi> = {
  'openai-completions': 'openai_completions',
  'anthropic-messages': 'anthropic_messages',
}
export const API_ENUM_TO_WIRE: Record<ProviderApi, ProviderApiWire> = {
  openai_completions: 'openai-completions',
  anthropic_messages: 'anthropic-messages',
}
