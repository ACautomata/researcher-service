// #337 M5 对话桥接核心（ADR 0006 隧道形态）：浏览器↔面板一条 WS，建立后原样透传
// 浏览器↔容器网关的 OpenClaw 协议 v4 原始帧。
//
//   - 握手：JWT subprotocol（['access_token', <jwt>] / ['access_token.<jwt>'] 两格式）+ 原样回显
//     （RFC 6455）；验签 = authenticate()（与 REST 严格同源，jose HS256 + Prisma 查 user 存在且
//     active——禁用/删 user WS 立即生效）；归属门 = getInstanceForUser（user 只能开自己容器，
//     越权/不存在同码 4401 防探测）。
//   - 拒绝语义：先 accept 再 close(4401)（保前端 recoverUnauthorized 刷新重连链路，HTTP 401 只得
//     1006 故不简化）。容器网关连不上 → close(4402)（非认证问题，前端不应 forceRefresh）。
//   - 透传：隧道建立后帧内容原样转发（零解析/零翻译/不注入凭证/不做 method 级授权）。断连/重连
//     由浏览器侧官方协议机处理，后端仅透传。
//
// 实现要点：网关连接建立前把浏览器入站帧缓冲到 pending（handleUpgrade accept 后浏览器即可发帧，
// 而此时认证/归属/网关连接均为 await——未监听即丢帧）。

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import type { PrismaClient } from '../generated/prisma/client'
import { authenticate } from '../auth/authenticate'
import { getInstanceForUser } from '../containers/orchestrator'
import { parseProtocolToken, chooseProtocol } from './subprotocol'
import {
  WS_CHAT_PATH,
  WS_AUTH_FAIL_CLOSE,
  WS_GATEWAY_UNAVAILABLE,
  WS_MUST_CHANGE_PASSWORD_CLOSE,
  WS_POLICY_VIOLATION,
  TUNNEL_PENDING_BYTE_BUDGET,
  TUNNEL_MAX_PAYLOAD,
} from './values'
import type { GatewayConnector, GatewaySocket } from './gatewayConnector'

export interface TunnelDeps {
  prisma: PrismaClient
  // 连接容器网关的传输接缝（测试注入 fake）
  connectGateway: GatewayConnector
  // 容器网关宿主地址（config.fleet.healthHost；生产 127.0.0.1）
  gatewayHost: string
}

// 网关 close code 传导 sanitize（安全审查 P1-1，codex PR #367）：RFC 6455 保留码 1004/1005/1006
// 不能放进 close frame——ws sender.close 对非法码同步抛 TypeError（实测网关异常断开时 Node ws 报
// 1006，直接 ws.close(1006) 抛错且浏览器收不到 close、隧道悬空）。合法区间原样传
//（1000-1014 非保留 + 3000-4999）；非法 → 4402 网关不可达（异常断开即网关挂，语义正确）。
export function sanitizeGatewayCloseCode(code: number): number {
  const valid =
    (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
  return valid ? code : WS_GATEWAY_UNAVAILABLE
}

export interface TunnelServer {
  // 接管 /ws/chat/ 路径的 upgrade 请求；返回 false = 非本路径，调用方自行处置（destroy）。
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean
  // 终止全部活动隧道（优雅关闭用）：http.Server.close() 会等升级后的 WS 连接自然断开——有浏览器
  // 持隧道时部署/重启会挂起，须先 terminate 全部隧道再 close（code review P2）。
  close(): void
}

// createTunnelServer：noServer + handleUpgrade 手动鉴权（#314 调研首选路径），subprotocol
// 经 chooseProtocol 原样回显（两值→access_token，单值→access_token.<jwt>，无声明→不选仍 accept）。
export function createTunnelServer(deps: TunnelDeps): TunnelServer {
  const wss = new WebSocketServer({
    noServer: true,
    // 单帧载荷上限（P1-2）：不设则 ws 默认 100MiB，未认证客户端可在验签 await 窗口内发近 100MiB
    // 帧打满内存（pending 预算 256KiB 是 handler 内事后检查）。超限帧 ws 直接 close(1009)。
    maxPayload: TUNNEL_MAX_PAYLOAD,
    // chooseProtocol 返回 undefined（无 access_token 声明）→ 不选 subprotocol 仍 accept，由 token
    // 校验层决定 4401（对齐现状「无 subprotocol 地 accept」，不在握手层拒绝）。断言适配 @types/ws
    // 的 `string | false`：ws 8.x 运行时对 falsy 返回不 push subprotocol header 且不 abort 握手。
    handleProtocols: (protocols) => chooseProtocol(protocols) as string | false,
  })
  return {
    handleUpgrade(req, socket, head) {
      if (!req.url?.startsWith(WS_CHAT_PATH)) return false
      // upgrade 请求异常（连接被对端 abort 等）→ destroy，避免悬空 socket
      socket.on('error', () => socket.destroy())
      wss.handleUpgrade(req, socket, head, (ws) => {
        void handleConnection(ws, req, deps)
      })
      return true
    },
    close() {
      // 立即关闭全部活动隧道（terminate 不等 close 握手，防优雅关闭挂起）
      for (const client of wss.clients) client.terminate()
    },
  }
}

async function handleConnection(ws: WebSocket, req: IncomingMessage, deps: TunnelDeps): Promise<void> {
  // 立即注册浏览器侧监听（accept 后浏览器即可发帧/断开；下述 await 期间未监听即丢帧/泄漏）：
  //   - message → 缓冲到 pending（网关连好后 flush，见下）
  //   - close → 网关连好后关闭它（浏览器 early-close 也捕获，防泄漏）
  //   - error → receiver 传输错误（如 maxPayload 超限 WS_ERR_UNSUPPORTED_MESSAGE_LENGTH）emit 到
  //     ws 实例；无 listener 会抛成 uncaught 终止进程。隧道只透传，error 由 close 事件兜底清理。
  ws.on('error', () => {})
  let gateway: GatewaySocket | null = null
  const pending: string[] = []
  let pendingBytes = 0
  ws.on('message', (data) => {
    // close() 后已缓冲的 TCP 数据仍可能触发 message → 丢弃，防 close 后继续转发/缓冲
    if (ws.readyState !== WebSocket.OPEN) return
    // 协议机只发文本帧（send(string)）；data.toString() 对 text 帧无损。帧内容不做任何解析。
    const frame = data.toString()
    if (gateway === null) {
      // 网关连接建立前缓冲（网关连好后 flush）。字节预算上限防恶意客户端在连接窗口内狂发帧
      // 导致内存无界增长（resource-exhaustion）——超限即策略违反 close(1008)。
      pendingBytes += Buffer.byteLength(frame)
      if (pendingBytes > TUNNEL_PENDING_BYTE_BUDGET) {
        ws.close(WS_POLICY_VIOLATION)
        return
      }
      pending.push(frame)
      return
    }
    gateway.send(frame)
  })
  ws.on('close', () => {
    if (gateway !== null) gateway.close()
  })

  // 1. JWT subprotocol 验签（与 REST authenticate() 同源：签名 + 查库 user 存在且 active）
  const token = parseProtocolToken(req.headers['sec-websocket-protocol'])
  if (token === null) {
    ws.close(WS_AUTH_FAIL_CLOSE)
    return
  }
  let user
  try {
    user = await authenticate(token, deps.prisma)
  } catch {
    ws.close(WS_AUTH_FAIL_CLOSE)
    return
  }
  // 强制改密门（authorization-gate-parity）：与 REST mustChangePasswordGate 同源——mustChangePassword
  // 用户不得经隧道访问容器，否则强制改密被绕过。
  if (user.mustChangePassword) {
    ws.close(WS_MUST_CHANGE_PASSWORD_CLOSE)
    return
  }

  // 2. 归属门：容器名经 URL query 传入，user 只能开自己容器（越权/不存在同码 4401 防探测）
  const name = new URL(req.url!, 'ws://localhost').searchParams.get('container')
  if (!name) {
    ws.close(WS_AUTH_FAIL_CLOSE)
    return
  }
  let inst
  try {
    inst = await getInstanceForUser(deps.prisma, user, name)
  } catch {
    ws.close(WS_AUTH_FAIL_CLOSE)
    return
  }

  // 3. 连容器网关（透传目标）。失败 = 容器网关不可达（容器不在 running / 端口不通）→ 4402。
  try {
    gateway = await deps.connectGateway.connect(`ws://${deps.gatewayHost}:${inst.port}/`)
  } catch {
    ws.close(WS_GATEWAY_UNAVAILABLE)
    return
  }
  // 浏览器在网关连接建立期间已断开（ws.on('close') 触发时 gateway 尚为 null、未能关闭）→
  // 刚建好的网关连接无人消费，立即关闭防容器网关侧挂死连接。
  if (ws.readyState !== WebSocket.OPEN) {
    gateway.close()
    return
  }
  for (const frame of pending) gateway.send(frame)
  pending.length = 0

  // 4. 双向透传（零解析：帧内容原样转发，不做 JSON/协议/授权处理）。
  //    断连/重连由浏览器侧官方协议机处理；后端只做字节管道。
  gateway.onMessage((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  })
  gateway.onClose((code) => {
    // 网关断开 → 关隧道，把 close code 传导给浏览器（浏览器侧协议机决策重连）。
    // 保留码（1006/1005/1004）先 sanitize 再 close——直接传会同步抛 TypeError 且浏览器收不到
    // close 帧（隧道悬空，见 sanitizeGatewayCloseCode）。
    if (ws.readyState === WebSocket.OPEN) ws.close(sanitizeGatewayCloseCode(code))
  })
  gateway.onError(() => {
    // 网关传输错误：关隧道让浏览器侧协议机决策重连
    if (ws.readyState === WebSocket.OPEN) ws.close(WS_GATEWAY_UNAVAILABLE)
  })
}
