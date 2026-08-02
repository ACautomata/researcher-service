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
  // 强制 gateway.mode=local（spec §5.2 安全不变量）：缺省/漂移模板若不强制，gateway 启动
  // 即崩（"missing gateway.mode"），容器退出码 78 无限重启（M2 smoke CI 失败根因）。
  gateway.mode = 'local'
  const auth = (gateway.auth ?? {}) as Record<string, unknown>
  // codex 七轮 P2：强制 auth.mode=token——模板缺省/漂移到其他模式时，仅设 token 字段会被忽略或
  // 用意外认证启动。token 模式是每容器 GATEWAY_TOKEN 生效的前提（spec §5.2 凭证不变量）。
  auth.mode = 'token'
  auth.token = GATEWAY_TOKEN_PLACEHOLDER // 强制占位：杜绝真 token 落盘
  gateway.auth = auth
  template.gateway = gateway
  return JSON.stringify(template, null, 2)
}
