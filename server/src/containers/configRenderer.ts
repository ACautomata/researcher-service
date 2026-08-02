// openclaw.json 渲染（平移 backend/containers/config_renderer.py，#334）。
// 配置单一来源 = 模板文件（与单容器 compose 共用一份）。每容器渲染产物落到
// instances/<name>/openclaw.json，bind-mount(ro) 覆盖进容器。
// token 策略：gateway.auth.token 保留 ${GATEWAY_TOKEN} env 占位 —— 真值由 docker env
// GATEWAY_TOKEN=<secret> 注入，真 token 绝不落盘进 JSON 文件（安全不变量）。

import { GATEWAY_BIND, GATEWAY_INTERNAL_PORT, GATEWAY_TOKEN_PLACEHOLDER } from './constants'

interface OpenClawConfig {
  gateway?: {
    port?: number
    bind?: string
    auth?: { token?: string }
    [k: string]: unknown
  }
  [k: string]: unknown
}

export class ConfigRenderer {
  private readonly template: OpenClawConfig

  constructor(templateText: string) {
    // 构造期解析：损坏模板 fail-fast（不静默产出坏配置）
    this.template = JSON.parse(templateText) as OpenClawConfig
  }

  // 渲染并强制 spec 安全不变量（port/bind/token），返回 dict（供 ProviderConfigBuilder 合并）
  renderDict(): OpenClawConfig {
    const cfg = structuredClone(this.template)
    const gateway = (cfg.gateway ??= {})
    gateway.port = GATEWAY_INTERNAL_PORT
    gateway.bind = GATEWAY_BIND
    // 强制占位：杜绝真 token 落盘（即便上游模板写错）
    const auth = (gateway.auth ??= {})
    auth.token = GATEWAY_TOKEN_PLACEHOLDER
    return cfg
  }

  render(): string {
    return JSON.stringify(this.renderDict(), null, 2)
  }
}
