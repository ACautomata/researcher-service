// #337 M5 隧道前端侧（ADR 0006 B-直连）：面板隧道 socket。
// 官方 `@openclaw/gateway-client/browser` 的 GatewayProtocolClient 要求注入 createSocket，返回
// `GatewayProtocolSocket`（{isOpen, send, close}）。本模块把「浏览器↔面板的一条 WS」适配成该接口：
//   - URL `/ws/chat/?container=<name>`（容器名经 query 传入，后端归属门校验越权 4401）
//   - JWT subprotocol `['access_token', <jwt>]`（两格式之一；token 不进 URL/日志）
//   - 后端隧道零解析透传：send(data) 原样发给容器网关，网关帧原样进 handlers.message
// 协议 v4 握手/重连/帧状态机/会话投影全由官方协议机负责，本类只做 transport 适配。

import type { GatewayProtocolSocket, GatewayProtocolSocketHandlers } from '@openclaw/gateway-client/browser'

export function createPanelTunnelSocket(
  container: string,
  jwt: string,
  handlers: GatewayProtocolSocketHandlers,
): GatewayProtocolSocket {
  // 容器名 encodeURIComponent：DNS-label 本就安全，防御性编码防 URL 注入。
  // 原生 WebSocket 构造函数要求绝对 URL（ws:/wss: scheme），相对路径抛 SyntaxError（P1-3，
  // codex PR #367；单元测试曾用 mock 掩盖）。按页面协议选 wss:/ws:（HTTPS 页面明文 ws 被浏览器拒）。
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${scheme}//${window.location.host}/ws/chat/?container=${encodeURIComponent(container)}`
  const ws = new WebSocket(url, ['access_token', jwt])
  ws.onopen = () => handlers.open()
  // 协议机只发文本帧（send(string)）；网关回帧亦为文本 → ev.data 为 string
  ws.onmessage = (ev) => handlers.message(ev.data as string)
  ws.onclose = (ev) => handlers.close(ev.code, ev.reason)
  ws.onerror = () => handlers.error(new Error('panel tunnel error'))
  return {
    isOpen: () => ws.readyState === WebSocket.OPEN,
    // CONNECTING 时原生 send 抛 InvalidStateError；CLOSING/CLOSED 静默丢弃（对齐 WHATWG 语义）。
    // 守卫仅放开 OPEN 态，其余走协议机的 error/close 决策链。
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    },
    close: (code, reason) => ws.close(code, reason),
  }
}
