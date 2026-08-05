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

// Codex 第七轮 #6[P2]：renderer 仅强制 token 字段不够 —— 模板若选了 auth.mode 非 token、或开了
// controlUi.allowInsecureAuth，则 GATEWAY_TOKEN 可被绕过（生产 publishHost=0.0.0.0 尤甚）。renderer 是
// gateway 安全不变量的强制点，须强制 mode=token / insecure=off，不信模板值（对齐 port/bind/token）。
describe('ConfigRenderer 强制 token 认证不变量 (Codex 第七轮 #6)', () => {
  it('模板 auth.mode=none → renderDict 强制为 token', () => {
    const r = new ConfigRenderer(JSON.stringify({ gateway: { auth: { mode: 'none' } } }))
    const out = r.renderDict()
    expect(out.gateway?.auth?.mode).toBe('token')
    expect(out.gateway?.auth?.token).toBe(GATEWAY_TOKEN_PLACEHOLDER)
  })

  it('模板 controlUi.allowInsecureAuth=true → renderDict 强制为 false', () => {
    const r = new ConfigRenderer(
      JSON.stringify({ gateway: { controlUi: { allowInsecureAuth: true } } }),
    )
    const out = r.renderDict()
    expect(out.gateway?.controlUi?.allowInsecureAuth).toBe(false)
  })

  it('模板缺 auth.mode / controlUi → renderDict 补 mode=token / insecure=false', () => {
    const r = new ConfigRenderer(JSON.stringify({ gateway: {} }))
    const out = r.renderDict()
    expect(out.gateway?.auth?.mode).toBe('token')
    expect(out.gateway?.controlUi?.allowInsecureAuth).toBe(false)
  })
})

// #385 生产 Origin 接线：面板 origin 须在容器 gateway.controlUi.allowedOrigins 内（真网关 2026.7.1
// 校验 WS Origin，PR #384 实测）——否则面板后端隧道连容器网关被 CONTROL_UI_ORIGIN_NOT_ALLOWED 拒。
// deploy/openclaw.json 模板仅含 localhost/127.0.0.1 seed，面板 origin 由 env 注入 → 强制点必在
// renderer（配置单一来源），与 allowInsecureAuth=false 同模式：追加/覆盖，不信模板值。
describe('ConfigRenderer 强制 allowedOrigins 含面板 origin (#385)', () => {
  it('模板已有 allowedOrigins → 面板 origin 追加保留（不重复、不覆盖既有条目）', () => {
    const r = new ConfigRenderer(
      JSON.stringify({
        gateway: { controlUi: { allowedOrigins: ['http://localhost:18789'] } },
      }),
    )
    const out = r.renderDict('https://panel.example.com')
    expect(out.gateway?.controlUi?.allowedOrigins).toEqual([
      'http://localhost:18789',
      'https://panel.example.com',
    ])
  })

  it('模板缺失 allowedOrigins → 建数组（仅面板 origin）', () => {
    const r = new ConfigRenderer(JSON.stringify({ gateway: {} }))
    const out = r.renderDict('https://panel.example.com')
    expect(out.gateway?.controlUi?.allowedOrigins).toEqual(['https://panel.example.com'])
  })

  it('面板 origin 已在模板中 → 不重复追加', () => {
    const r = new ConfigRenderer(
      JSON.stringify({
        gateway: { controlUi: { allowedOrigins: ['https://panel.example.com'] } },
      }),
    )
    const out = r.renderDict('https://panel.example.com')
    expect(out.gateway?.controlUi?.allowedOrigins).toEqual(['https://panel.example.com'])
  })

  it('模板 allowedOrigins 为非法形状（非数组）→ 重写为仅面板 origin（不静默丢不变量）', () => {
    const r = new ConfigRenderer(
      JSON.stringify({ gateway: { controlUi: { allowedOrigins: 'http://localhost' } } }),
    )
    const out = r.renderDict('https://panel.example.com')
    expect(out.gateway?.controlUi?.allowedOrigins).toEqual(['https://panel.example.com'])
  })

  it('未传面板 origin（空串）→ 不动 allowedOrigins（旧 call 面保持模板原样）', () => {
    const r = new ConfigRenderer(
      JSON.stringify({
        gateway: { controlUi: { allowedOrigins: ['http://localhost:18789'] } },
      }),
    )
    const out = r.renderDict()
    expect(out.gateway?.controlUi?.allowedOrigins).toEqual(['http://localhost:18789'])
  })

  it('强制 allowedOrigins 时 allowInsecureAuth=false 不变量保持', () => {
    const r = new ConfigRenderer(JSON.stringify({ gateway: {} }))
    const out = r.renderDict('https://panel.example.com')
    expect(out.gateway?.controlUi?.allowInsecureAuth).toBe(false)
    expect(out.gateway?.controlUi?.allowedOrigins).toEqual(['https://panel.example.com'])
    // port/bind/token 不变量不受影响
    expect(out.gateway?.port).toBe(GATEWAY_INTERNAL_PORT)
    expect(out.gateway?.bind).toBe(GATEWAY_BIND)
    expect(out.gateway?.auth?.token).toBe(GATEWAY_TOKEN_PLACEHOLDER)
  })

  it('模板已有 allowedOrigins 含面板 origin → render() 序列化产物含它（create 写盘路径）', () => {
    const r = new ConfigRenderer(JSON.stringify({ gateway: {} }))
    const out = JSON.parse(r.render('https://panel.example.com'))
    expect(out.gateway.controlUi.allowedOrigins).toEqual(['https://panel.example.com'])
  })
})
