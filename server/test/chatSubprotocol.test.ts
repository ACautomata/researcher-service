// #337 M5 隧道：Sec-WebSocket-Protocol 两格式解析 + subprotocol 回显选择（对齐 Django
// accounts/middleware.py._extract_token + _choose_subprotocol 语义，测试接缝 3 WS 桥）。
// 纯函数无 I/O：直接单测，不经 HTTP。

import { describe, it, expect } from 'vitest'
import { parseProtocolToken, chooseProtocol } from '../src/chat/subprotocol'

describe('parseProtocolToken（两格式 wire）', () => {
  it('格式① [' + "'access_token', <jwt>]" + ' → 取第 2 项', () => {
    expect(parseProtocolToken('access_token, eyJ0okEn') ).toBe('eyJ0okEn')
  })

  it('格式① 逗号后空格容忍（浏览器 header 常带空格）', () => {
    expect(parseProtocolToken('access_token,   eyJ0okEn')).toBe('eyJ0okEn')
  })

  it('格式② [' + "'access_token.<jwt>'" + '] 单值拼接 → 取前缀后缀', () => {
    expect(parseProtocolToken('access_token.eyJ0okEn')).toBe('eyJ0okEn')
  })

  it('仅 access_token 无 jwt（len<2）→ null', () => {
    expect(parseProtocolToken('access_token')).toBeNull()
  })

  it('无 access_token 声明 → null', () => {
    expect(parseProtocolToken('other, subproto')).toBeNull()
  })

  it('undefined / 空串 header → null', () => {
    expect(parseProtocolToken(undefined)).toBeNull()
    expect(parseProtocolToken('')).toBeNull()
  })

  it('重复 header 合并数组 → 取第 2 项（对齐 Django subprotocols 列表语义）', () => {
    expect(parseProtocolToken(['access_token', 'eyJ0okEn'])).toBe('eyJ0okEn')
  })

  it('首项非 access_token 时格式①不匹配，前缀循环亦不匹配 → null（对齐 _extract_token 顺序语义）', () => {
    expect(parseProtocolToken('other, access_token, eyJ0okEn')).toBeNull()
  })
})

describe('chooseProtocol（RFC 6455 原样回显）', () => {
  it('两值格式 → 回显 access_token', () => {
    expect(chooseProtocol(new Set(['access_token', 'eyJ0okEn']))).toBe('access_token')
  })

  it('单值格式 → 原样回显 access_token.<jwt>（不能硬编码 access_token，否则浏览器拒握手 1006）', () => {
    expect(chooseProtocol(new Set(['access_token.eyJ0okEn']))).toBe('access_token.eyJ0okEn')
  })

  it('两格式并存 → 优先回显 access_token', () => {
    expect(chooseProtocol(new Set(['access_token.eyJ0okEn', 'access_token']))).toBe('access_token')
  })

  it('无 access_token 声明 → undefined（不选 subprotocol 仍 accept，token 校验层决定 4401）', () => {
    expect(chooseProtocol(new Set(['other']))).toBeUndefined()
  })
})
