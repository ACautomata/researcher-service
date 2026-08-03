// #337 M5 隧道 subprotocol 解析（对齐 Django accounts/middleware.py._extract_token /
// _choose_subprotocol，测试接缝 3 WS 桥）。纯函数无 I/O。
//
// 两种 wire format（token 不走 URL query，避免进访问日志/浏览器历史/Referer 泄漏）：
//   1) new WebSocket(url, ['access_token', <jwt>])  → subprotocols = ['access_token', <jwt>]
//   2) new WebSocket(url, ['access_token.<jwt>'])    → subprotocols = ['access_token.<jwt>']
// RFC 6455 要求握手响应 subprotocol 必须来自客户端声明之一——单值格式须原样回显，
// 硬编码 'access_token' 会让浏览器拒握手（1006）。

import { WS_CHAT_PROTOCOL } from './values'

type HeaderValue = string | string[] | undefined

// 从原始 Sec-WebSocket-Protocol header 提取 JWT。
// 复刻 _extract_token 顺序语义：格式①要求「首项恰为 access_token 且长度≥2」→ 取第 2 项；
// 否则前缀循环匹配 access_token.<jwt> → 取后缀；都不中 → null。
export function parseProtocolToken(header: HeaderValue): string | null {
  if (header === undefined) return null
  const raw = Array.isArray(header) ? header.join(',') : header
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  if (parts.length >= 2 && parts[0] === WS_CHAT_PROTOCOL) return parts[1]
  for (const p of parts) {
    if (p.startsWith(`${WS_CHAT_PROTOCOL}.`)) return p.slice(WS_CHAT_PROTOCOL.length + 1)
  }
  return null
}

// RFC 6455 subprotocol 回显选择（ws handleProtocols 钩子）：从客户端声明集合里选一个返回。
// 返回 undefined = 不选 subprotocol 但仍 accept（token 校验层决定是否 4401，对齐现状
// 「客户端未声明 access_token 时无 subprotocol 地 accept」——不在握手层拒绝）。
export function chooseProtocol(protocols: ReadonlySet<string>): string | undefined {
  if (protocols.has(WS_CHAT_PROTOCOL)) return WS_CHAT_PROTOCOL
  for (const p of protocols) {
    if (p.startsWith(`${WS_CHAT_PROTOCOL}.`)) return p
  }
  return undefined
}
