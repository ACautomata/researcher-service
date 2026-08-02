import { readFileSync } from 'node:fs'
import {
  GATEWAY_BIND,
  GATEWAY_INTERNAL_PORT,
  GATEWAY_TOKEN_PLACEHOLDER,
} from '../orchestrator/ports'

// openclaw.json 渲染（spec §5.2 / deploy/openclaw.json 单一来源）。
// 每容器渲染产物落到 instances/<name>/openclaw.json，bind-mount(ro) 覆盖进容器。
// token 策略：gateway.auth.token 保留 ${GATEWAY_TOKEN} env 占位 —— 真值由 docker env
// GATEWAY_TOKEN=<secret> 注入。强制 spec 安全不变量（port/bind/token 占位），模板漂移也合规。

export function renderGatewayConfig(templateJsonPath: string): string {
  const template = JSON.parse(readFileSync(templateJsonPath, 'utf8')) as Record<string, unknown>
  const gateway = (template.gateway ?? {}) as Record<string, unknown>
  gateway.port = GATEWAY_INTERNAL_PORT
  gateway.bind = GATEWAY_BIND
  const auth = (gateway.auth ?? {}) as Record<string, unknown>
  auth.token = GATEWAY_TOKEN_PLACEHOLDER // 强制占位：杜绝真 token 落盘
  gateway.auth = auth
  template.gateway = gateway
  return JSON.stringify(template, null, 2)
}
