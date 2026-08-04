// #337 M5 隧道 subprotocol 解析（对齐 Django accounts/middleware.py._extract_token /
// _choose_subprotocol，测试接缝 3 WS 桥）。纯函数无 I/O。
//
// 两种 wire format（token 不走 URL query，避免进访问日志/浏览器历史/Referer 泄漏）：
//   1) new WebSocket(url, ['access_token', <jwt>])  → subprotocols = ['access_token', <jwt>]
//   2) new WebSocket(url, ['access_token.<jwt>'])    → subprotocols = ['access_token.<jwt>']
// RFC 6455 要求握手响应 subprotocol 必须来自客户端声明之一——单值格式须原样回显，
// 硬编码 'access_token' 会让浏览器拒握手（1006）。

import { WS_CHAT_PROTOCOL } from './values'

// #3 P3：Node llhttp 对重复 Sec-WebSocket-Protocol 头以 ', ' 合并为单一字符串
// （req.headers['sec-websocket-protocol'] 恒为 string）——联合里的 string[] 分支是死代码。
type HeaderValue = string | undefined

// 单一解析源（#8）：两种 wire format 的「token 提取 + 回显选择」共用同一份判定，杜绝
// parseProtocolToken（提取）与 chooseProtocol（回显）两份拷贝漂移——非规范头（如首项非
// access_token 但集合含 access_token）下提取判定 null 而回显却成功，造成「握手 accept 后
// 立即 4401」的矛盾。格式判定（复刻 _extract_token 顺序语义）：
//   ① parts[0] 恰为 access_token 且长度≥2 → token = parts[1]（回显 access_token）
//   ② 前缀循环匹配 access_token.<jwt> → token = 后缀（回显该完整项）
//   都不中 → token null（回显 undefined）——提取与回显永远同判。
function parseFromParts(parts: string[]): { token: string | null; echo: string | undefined } {
  if (parts.length >= 2 && parts[0] === WS_CHAT_PROTOCOL) {
    return { token: parts[1], echo: WS_CHAT_PROTOCOL }
  }
  for (const p of parts) {
    if (p.startsWith(`${WS_CHAT_PROTOCOL}.`)) return { token: p.slice(WS_CHAT_PROTOCOL.length + 1), echo: p }
  }
  return { token: null, echo: undefined }
}

// 从原始 Sec-WebSocket-Protocol header 提取 JWT。
export function parseProtocolToken(header: HeaderValue): string | null {
  if (header === undefined) return null
  const parts = header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  return parseFromParts(parts).token
}

// RFC 6455 subprotocol 回显选择（ws handleProtocols 钩子）：从客户端声明集合里选一个返回。
// 返回 undefined = 不选 subprotocol 但仍 accept（token 校验层决定是否 4401，对齐现状
// 「客户端未声明 access_token 时无 subprotocol 地 accept」——不在握手层拒绝）。
// 与 parseProtocolToken 同一判定源（#8）：token 提取失败时一律不回显——杜绝「握手 accept
// 但 token 校验层 4401」的判定分裂。回显偏好保留既有语义：两格式并存时优先回显 access_token。
export function chooseProtocol(protocols: ReadonlySet<string>): string | undefined {
  const parts = [...protocols]
  const { token, echo } = parseFromParts(parts)
  if (token === null) return undefined
  if (parts.includes(WS_CHAT_PROTOCOL)) return WS_CHAT_PROTOCOL
  return echo
}
