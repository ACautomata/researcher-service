// #337 M5 隧道前端侧（ADR 0006 B-直连）：面板隧道 socket。
// 官方 `@openclaw/gateway-client/browser` 的 GatewayProtocolClient 要求注入 createSocket，返回
// `GatewayProtocolSocket`（{isOpen, send, close}）。本模块把「浏览器↔面板的一条 WS」适配成该接口：
//   - URL `/ws/chat/?container=<name>`（容器名经 query 传入，后端归属门校验越权 4401）
//   - JWT subprotocol `['access_token', <jwt>]`（两格式之一；token 不进 URL/日志）
//   - 后端隧道零解析透传：send(data) 原样发给容器网关，网关帧原样进 handlers.message
// 协议 v4 握手/重连/帧状态机/会话投影全由官方协议机负责，本类只做 transport 适配。
//
// URL 形态（F11，code review）：相对路径 `/ws/chat/` —— WHATWG WebSocket 构造函数按文档 base URL
// 解析相对地址，既有 ChatWebSocket（chat/ws.ts）生产同款用法。绝对 URL（codex P1-3）基于
// 「相对路径抛 SyntaxError」的错误前提，且引入 window.location 依赖、subpath 部署下同样丢前缀。

import type { GatewayProtocolSocket, GatewayProtocolSocketHandlers } from '@openclaw/gateway-client/browser'
import { buildSubprotocols } from './protocol'

export function createPanelTunnelSocket(
  container: string,
  jwt: string,
  handlers: GatewayProtocolSocketHandlers,
): GatewayProtocolSocket {
  // 容器名 encodeURIComponent：DNS-label 本就安全，防御性编码防 URL 注入。
  const url = `/ws/chat/?container=${encodeURIComponent(container)}`
  const ws = new WebSocket(url, buildSubprotocols(jwt))
  ws.onopen = () => handlers.open()
  // 协议机只发文本帧（send(string)）；网关回帧亦为文本 → ev.data 为 string
  ws.onmessage = (ev) => handlers.message(ev.data as string)
  ws.onclose = (ev) => handlers.close(ev.code, ev.reason)
  // F7（code review）：不得把真实失败原因压成常量 'panel tunnel error'——ECONNREFUSED/DNS/网络
  // 掉线全在该日志面上，无法排障。ErrorEvent 带 message（如 'WebSocket connection to ... failed'）
  // 时原样透传；非 ErrorEvent（跨源受限等）给通用兜底。
  ws.onerror = (ev) => {
    const detail = ev instanceof ErrorEvent ? ev.message : 'WebSocket transport error'
    handlers.error(new Error(detail))
  }
  return {
    isOpen: () => ws.readyState === WebSocket.OPEN,
    // CONNECTING 时原生 send 抛 InvalidStateError；CLOSING/CLOSED 静默丢弃（对齐 WHATWG 语义）。
    // 守卫仅放开 OPEN 态，其余走协议机的 error/close 决策链。
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    },
    close: (code, reason) => {
      // #4：WHATWG 只允许 1000/3000-4999 的 close code——官方协议机 connect 失败路径用 1008/1013 等
      // RFC 应用码调 socket.close，直接透传原生 WebSocket.close 会抛 InvalidAccessError（socket 关
      // 不掉、onclose 不触发 → 协议机重连由 handlers.close 驱动、永不调度，隧道假活）。非法码映射
      // 1000 关闭（WHATWG 合法），原码带进 reason 保排障。
      const legal = code === undefined || code === 1000 || (code >= 3000 && code <= 4999)
      if (legal) ws.close(code, reason)
      else ws.close(1000, `closed(${code})`)
    },
  }
}
