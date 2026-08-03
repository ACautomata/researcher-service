// openclaw.json 渲染（平移 backend/containers/config_renderer.py，#334）。
// 配置单一来源 = 模板文件（与单容器 compose 共用一份）。每容器渲染产物落到
// instances/<id>/config/openclaw.json（#366：config 独立目录 ro bind + OPENCLAW_CONFIG_PATH）。
// token 策略：gateway.auth.token 保留 ${GATEWAY_TOKEN} env 占位 —— 真值由 docker env
// GATEWAY_TOKEN=<secret> 注入，真 token 绝不落盘进 JSON 文件（安全不变量）。

import { GATEWAY_BIND, GATEWAY_INTERNAL_PORT, GATEWAY_TOKEN_PLACEHOLDER } from './constants'
import { ConfigurationError } from './errors'

interface OpenClawConfig {
  gateway?: {
    port?: number
    bind?: string
    auth?: { token?: string; mode?: string; [k: string]: unknown }
    controlUi?: { allowInsecureAuth?: boolean; [k: string]: unknown }
    [k: string]: unknown
  }
  [k: string]: unknown
}

// 形状断言（Codex C9）：JSON.parse 成功但值非「普通对象」时，renderDict 挂到其上的 gateway 属性
// 会被 JSON.stringify 丢弃（数组只序列化 index 属性、原始值无属性）→ openclaw.json 缺
// port/bind/token 强制不变量。构造期同步拒绝，避免坏配置留到后台 provisioning 才暴露（POST 已返 creating）。
// export：ProviderConfigBuilder 合并 models/agents/secrets 时复用同一断言（#366 codex 三轮 P2）——
// typeof [] === 'object'，须显式排除数组，否则挂到数组上的 named property 被 JSON.stringify 静默丢弃。
export function assertPlainObject(v: unknown, field: string): asserts v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ConfigurationError(field)
  }
}

export class ConfigRenderer {
  private readonly template: OpenClawConfig

  constructor(templateText: string) {
    // 构造期解析：损坏模板 fail-fast（不静默产出坏配置）
    const parsed: unknown = JSON.parse(templateText)
    // shape 校验（Codex C9）：合法 JSON 但非对象 / gateway·auth 非对象 → 同步拒绝。
    assertPlainObject(parsed, 'OPENCLAW_TEMPLATE_JSON')
    const gateway = (parsed as { gateway?: unknown }).gateway
    if (gateway !== undefined) assertPlainObject(gateway, 'OPENCLAW_TEMPLATE_JSON (gateway)')
    const auth = (gateway as { auth?: unknown } | undefined)?.auth
    if (auth !== undefined) assertPlainObject(auth, 'OPENCLAW_TEMPLATE_JSON (gateway.auth)')
    this.template = parsed as OpenClawConfig
  }

  // 渲染并强制 spec 安全不变量（port/bind/token），返回 dict（供 ProviderConfigBuilder 合并）
  renderDict(): OpenClawConfig {
    const cfg = structuredClone(this.template)
    const gateway = (cfg.gateway ??= {})
    gateway.port = GATEWAY_INTERNAL_PORT
    gateway.bind = GATEWAY_BIND
    // 强制 token 认证 + 关 insecure-auth（Codex 第七轮 #6）：仅强制 token 字段不够——模板若选了
    // auth.mode 非 token 或开了 controlUi.allowInsecureAuth，GATEWAY_TOKEN 可被绕过（生产 publishHost
    // =0.0.0.0 尤甚）。renderer 是 gateway 安全不变量强制点，mode/insecure 不信模板值（对齐 port/bind）。
    const auth = (gateway.auth ??= {})
    auth.token = GATEWAY_TOKEN_PLACEHOLDER // 占位防真 token 落盘（即便上游模板写错）
    auth.mode = 'token'
    const controlUi = (gateway.controlUi ??= {})
    controlUi.allowInsecureAuth = false
    return cfg
  }

  render(): string {
    return JSON.stringify(this.renderDict(), null, 2)
  }
}
