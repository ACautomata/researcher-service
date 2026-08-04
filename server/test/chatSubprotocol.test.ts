// #337 M5 隧道：Sec-WebSocket-Protocol 两格式解析 + subprotocol 回显选择（对齐 Django
// accounts/middleware.py._extract_token + _choose_subprotocol 语义，测试接缝 3 WS 桥）。
// 纯函数无 I/O：直接单测，不经 HTTP。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseProtocolToken, chooseProtocol } from '../src/chat/subprotocol'
import { WS_CHAT_PROTOCOL } from '../src/chat/values'

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

  it('#8 一致性：token 提取失败时 chooseProtocol 不得回显（两份解析判定必须一致，防 accept 后 4401 矛盾）', () => {
    // 非规范头 ['other', 'access_token', <jwt>]：parseProtocolToken 因首项非 access_token → null（4401），
    // chooseProtocol 修复前却回显 access_token（握手 accept 后 token 校验层 4401——先 accept 再拒的矛盾）。
    // 修复后两者基于同一份解析 → chooseProtocol 也 undefined，语义一致。
    expect(parseProtocolToken('other, access_token, eyJ0okEn')).toBeNull()
    expect(chooseProtocol(new Set(['other', 'access_token', 'eyJ0okEn']))).toBeUndefined()
  })
})

describe('access_token wire 契约跨语言单一来源（#14）', () => {
  // 契约字面量硬编码在三个运行时（server Node values / frontend TS protocol / backend Python
  // middleware），无单一文件。改传输格式（前缀改名/加版本）须三处同步，否则 WS 握手静默 1006/4401。
  // 放 server（Node 环境）读源码文本 pin 三处一致——不引入 frontend 无 Node 类型的环境负担。
  // vitest 从 server/ 运行 → cwd=server，上级即仓库根。
  const ROOT = path.resolve(process.cwd(), '..')

  it('frontend/src/chat/protocol.ts 的 WS_CHAT_PROTOCOL 与 server values 一致', () => {
    const ts = readFileSync(path.join(ROOT, 'frontend/src/chat/protocol.ts'), 'utf8')
    expect(ts).toContain(`WS_CHAT_PROTOCOL = '${WS_CHAT_PROTOCOL}'`)
  })

  it('backend/accounts/middleware.py（Python Channels）字面量与 server values 一致（裸 access_token + access_token. 前缀两格式）', () => {
    const py = readFileSync(path.join(ROOT, 'backend/accounts/middleware.py'), 'utf8')
    expect(py).toContain(`'${WS_CHAT_PROTOCOL}'`)
    expect(py).toContain(`'${WS_CHAT_PROTOCOL}.`)
  })
})
