// ConfigRenderer 模板 shape 校验（Codex C9）。
// JSON.parse 成功但 shape 错（数组 / 原始值 / gateway·auth 为非对象）会让 renderDict 挂的
// gateway 属性被 JSON.stringify 丢弃（数组仅序列化 index 属性），生成的 openclaw.json 缺
// port/bind/token 强制不变量。构造期须 fail-fast（同步暴露配置错误，不留到后台 provisioning）。

import { describe, it, expect } from 'vitest'
import { ConfigRenderer } from '../src/containers/configRenderer'
import {
  GATEWAY_BIND,
  GATEWAY_INTERNAL_PORT,
  GATEWAY_TOKEN_PLACEHOLDER,
} from '../src/containers/constants'
import { ConfigurationError } from '../src/containers/errors'

describe('ConfigRenderer 模板 shape 校验 (Codex C9)', () => {
  it('数组模板 → 构造期拒绝（render 会静默丢 gateway 不变量）', () => {
    expect(() => new ConfigRenderer('[]')).toThrow(ConfigurationError)
  })

  it('原始值模板 → 构造期拒绝', () => {
    expect(() => new ConfigRenderer('"hello"')).toThrow(ConfigurationError)
    expect(() => new ConfigRenderer('42')).toThrow(ConfigurationError)
    expect(() => new ConfigRenderer('true')).toThrow(ConfigurationError)
    expect(() => new ConfigRenderer('null')).toThrow(ConfigurationError)
  })

  it('gateway 为原始值/数组 → 构造期拒绝', () => {
    expect(() => new ConfigRenderer(JSON.stringify({ gateway: 'lan' }))).toThrow(ConfigurationError)
    expect(() => new ConfigRenderer(JSON.stringify({ gateway: 18789 }))).toThrow(ConfigurationError)
    expect(() => new ConfigRenderer(JSON.stringify({ gateway: [1, 2, 3] }))).toThrow(ConfigurationError)
  })

  it('gateway.auth 为原始值/数组 → 构造期拒绝', () => {
    expect(() => new ConfigRenderer(JSON.stringify({ gateway: { auth: 'tok' } }))).toThrow(
      ConfigurationError,
    )
    expect(() => new ConfigRenderer(JSON.stringify({ gateway: { auth: ['a', 'b'] } }))).toThrow(
      ConfigurationError,
    )
  })

  it('合法对象模板 → render() 强制注入 port/bind/token 占位（回归保护）', () => {
    const r = new ConfigRenderer(JSON.stringify({ gateway: { auth: {} }, models: {} }))
    const out = JSON.parse(r.render())
    expect(out.gateway.port).toBe(GATEWAY_INTERNAL_PORT)
    expect(out.gateway.bind).toBe(GATEWAY_BIND)
    expect(out.gateway.auth.token).toBe(GATEWAY_TOKEN_PLACEHOLDER)
  })

  it('模板无 gateway 字段 → renderDict 补建并强制不变量（不拒绝）', () => {
    const r = new ConfigRenderer(JSON.stringify({ models: { providers: {} } }))
    const out = JSON.parse(r.render())
    expect(out.gateway.port).toBe(GATEWAY_INTERNAL_PORT)
    expect(out.gateway.auth.token).toBe(GATEWAY_TOKEN_PLACEHOLDER)
  })
})
