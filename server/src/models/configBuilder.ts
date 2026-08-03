// ProviderConfigBuilder —— openclaw.json models.providers 合并纯逻辑（平移 backend/models/config_builder.py，#336）。
//
// 纯领域逻辑（无 IO / 无 Prisma）：消费 ProviderSpec 列表，把 DB model provider 合并进
// base openclaw.json cfg，供 ModelConfigWriter 写盘经 OpenClaw watch 热加载生效。
//
// 规则（r28）：
// - 空 providers → base 透传（P0 兼容：无托管 provider 时沿用模板默认 minimax）。
// - 非空 → DB provider **全量替换** models.providers（DB 单一来源）；agents.defaults.model
//   按入参序重算 primary/fallbacks 与 agents.defaults.models 别名 —— 删除任一 provider
//   后天然无悬空引用（级联清理）。
// - apiKey 永远写 SecretRef {source:env, provider:default, id:<env_id>}，**不落明文**（r28 §2）。
// - api 取值（openai-completions / anthropic-messages）由 serializer 校验后经 ProviderSpec.api 原样写入。

import type { ProviderApiWire } from './values'
import { ConfigurationError } from '../containers/errors'

// SecretRef.provider 固定引用 deploy/openclaw.json 既有的 secrets.providers.default（r28 §2.1）
export const DEFAULT_SECRET_PROVIDER = 'default'

// ProviderConfigBuilder 的输入契约（与 Prisma ModelProvider 行解耦，便于纯单测）。
// models 为已校验的模型条目列表，每项形如
// {id, name, reasoning, input[], cost{input,output,cacheRead,cacheWrite}, contextWindow, maxTokens}
// （r28 §1.2，落盘时按 provider 形态原样输出）；id 必填非空（API 层已校验）。
export interface ProviderSpec {
  providerId: string
  api: ProviderApiWire
  baseUrl: string
  apiKeyEnvId: string
  authHeader: boolean
  models: Array<Record<string, unknown>>
}

// 把 base openclaw.json cfg 与 DB providers 合并为可写盘的 cfg dict（纯函数，不 mutate 入参）。
export class ProviderConfigBuilder {
  build(baseCfg: Record<string, unknown>, providers: readonly ProviderSpec[]): Record<string, unknown> {
    // 深拷贝：返回新对象，绝不 mutate 调用方 base（对齐 Python copy.deepcopy）
    const cfg = structuredClone(baseCfg)
    if (providers.length === 0) return cfg

    // #366 codex P2：非空 providers 必写 apiKey SecretRef(provider:default)（下方 renderProvider），
    // 先确认模板 secrets.providers.default 存在——否则写出的配置引用不存在的 secret provider，
    // openclaw 解析凭证失败、热加载被拒，但 DB 已提交报成功 = 不可用配置。缺失 → 90003
    // （复用 ConfigurationError，与意见 4 的模板错误转译同一条配置失败信封）。
    const secrets = cfg.secrets as { providers?: Record<string, unknown> } | undefined
    const defaultSecretProvider = secrets?.providers?.default
    if (typeof defaultSecretProvider !== 'object' || defaultSecretProvider === null) {
      throw new ConfigurationError('OPENCLAW_TEMPLATE_JSON (secrets.providers.default)')
    }

    const providersMap: Record<string, Record<string, unknown>> = {}
    const refs: string[] = [] // "<pid>/<mid>" 按序
    const aliases: Record<string, Record<string, string>> = {}
    for (const spec of providers) {
      providersMap[spec.providerId] = this.renderProvider(spec)
      for (const model of spec.models) {
        const ref = `${spec.providerId}/${String(model.id)}`
        refs.push(ref)
        aliases[ref] = { alias: (model.name as string | undefined) || String(model.id) }
      }
    }
    const models = (cfg.models ??= {}) as Record<string, unknown>
    models.providers = providersMap
    const agents = (cfg.agents ??= {}) as Record<string, unknown>
    const defaults = (agents.defaults ??= {}) as Record<string, unknown>
    defaults.model = { primary: refs[0], fallbacks: refs.slice(1) }
    defaults.models = aliases
    return cfg
  }

  renderProvider(spec: ProviderSpec): Record<string, unknown> {
    return {
      baseUrl: spec.baseUrl,
      apiKey: {
        source: 'env',
        provider: DEFAULT_SECRET_PROVIDER,
        id: spec.apiKeyEnvId,
      },
      api: spec.api,
      authHeader: spec.authHeader,
      models: spec.models.map((m) => structuredClone(m)),
    }
  }
}
