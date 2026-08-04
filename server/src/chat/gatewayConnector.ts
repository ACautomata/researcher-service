// #337 M5 隧道：容器网关连接 Port（测试接缝 3 WS 桥）。
// 后端隧道 = 浏览器↔面板一条 WS（JWT 归属门握手），建立后原样透传浏览器↔容器网关的
// OpenClaw 协议 v4 原始帧。本文件是「面板→容器网关」这条腿的传输层接缝：
//   生产 = makeWsGatewayConnector（Node ws 客户端连宿主 ws://<host>:<port>/）；
//   测试 = 注入内存 fake（断言帧字节级透传 + 零解析）。
// GatewaySocket 接口按官方 ./browser 协议机的纯文本帧契约设计（send/message 均为 string，
// 协议 v4 帧为 JSON 文本）。协议 v4 握手/重连/会话投影全由浏览器侧官方包负责，后端零解析。

import WebSocket from 'ws'
import { TUNNEL_MAX_PAYLOAD } from './values'

// 一个到容器网关的传输 socket（方向：后端⇄网关）。onMessage 即网关发来的原始协议帧。
// send/onMessage 载荷为 string | Buffer（#9）：文本帧 string（协议 v4 JSON 文本），二进制帧原样
// Buffer——字节管道契约，后端不得 toString 有损。
// （F13）onOpen 已移除——零消费者（tunnel.ts 从不订阅），投机接口面，违反 Simplicity First。
export interface GatewaySocket {
  send(data: string | Buffer): void
  close(code?: number, reason?: string): void
  onMessage(cb: (data: string | Buffer) => void): void
  onClose(cb: (code: number, reason: string) => void): void
  onError(cb: (err: Error) => void): void
}

// 连接工厂：按 URL 建立到容器网关的传输。
export interface GatewayConnector {
  connect(url: string): Promise<GatewaySocket>
}

const CONNECT_TIMEOUT_MS = 5000

// 生产实现：Node ws 客户端。resolve 时机 = TCP/WS 传输层 open（非协议 v4 connect——那由浏览器侧
// 官方协议机经隧道发出）。连接失败/超时 reject → 隧道层 close(4402) 让浏览器感知容器网关不可用。
// 连接建立瞬间网关可能立即主动发帧（如 connect.challenge，网关不依赖客户端先发）——open→resolve→
// 调用方注册 onMessage 的窗口内到达的帧先缓冲，注册后 flush，防丢首帧。
export function makeWsGatewayConnector(timeoutMs = CONNECT_TIMEOUT_MS): GatewayConnector {
  return {
    connect(url) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { maxPayload: TUNNEL_MAX_PAYLOAD })
        const timer = setTimeout(() => {
          ws.terminate()
          reject(new Error(`gateway connect timeout: ${url}`))
        }, timeoutMs)
        // connect 阶段错误 → reject；连接建立后的错误交给 onError（透传层决定是否关隧道）。
        // 用 on + open 内 removeListener 注册（F9）：once 的包装 listener 无法精确移除，且 once
        // 留着会在 open 后任何 error（容器重启 ECONNRESET）上再次触发 reject/clearTimeout——今天
        // 幂等无害，一旦 onConnectError 获得副作用（日志/计数）就双触发。open/失败都显式移除。
        const onConnectError = (err: Error): void => {
          clearTimeout(timer)
          ws.removeListener('error', onConnectError)
          reject(err)
        }
        ws.on('error', onConnectError)
        let msgCb: ((data: string | Buffer) => void) | null = null
        const buffered: Array<string | Buffer> = []
        ws.on('message', (data, isBinary) => {
          // #9：文本帧 toString（无损）；二进制帧原样 Buffer——Node ws 默认 binaryType=nodebuffer，
          // isBinary 时 data 即原始字节。toString 会把 0xff/0x80 有损为 U+FFFD mojibake 并以文本帧
          // 重发，违背「字节管道」契约。
          const frame = isBinary ? (data as Buffer) : (data as Buffer).toString()
          if (msgCb) msgCb(frame)
          else buffered.push(frame)
        })
        ws.once('open', () => {
          clearTimeout(timer)
          // 连接已建立：移除 connect 阶段处理器，post-open error 只走下方 onError（记录+重放）
          ws.removeListener('error', onConnectError)
          // 终态事件记录（P2-4，codex PR #367）：网关可能在 onClose/onError 注册前就断开（容器
          // 重启中）——EventEmitter.on 不重放已发生事件，须像下方消息缓冲一样记录终态，注册时
          // 重放。否则浏览器隧道保持 OPEN 但上游已死，官方协议机收不到 close/error 无法重连（假活）。
          let closed = false
          let closeCode = 0
          let closeReason = ''
          let errored: Error | null = null
          const closeCbs: Array<(code: number, reason: string) => void> = []
          const errorCbs: Array<(err: Error) => void> = []
          ws.on('close', (code, reason) => {
            closed = true
            closeCode = code
            closeReason = reason.toString()
            for (const cb of closeCbs) cb(closeCode, closeReason)
          })
          ws.on('error', (err) => {
            errored = err
            for (const cb of errorCbs) cb(err)
          })
          const socket: GatewaySocket = {
            send: (data) => {
              if (ws.readyState === WebSocket.OPEN) ws.send(data)
            },
            close: (code, reason) => ws.close(code, reason),
            onMessage: (cb) => {
              msgCb = cb
              for (const frame of buffered) cb(frame)
              buffered.length = 0
            },
            onClose: (cb) => {
              if (closed) cb(closeCode, closeReason)
              else closeCbs.push(cb)
            },
            onError: (cb) => {
              if (errored) cb(errored)
              else errorCbs.push(cb)
            },
          }
          resolve(socket)
        })
      })
    },
  }
}
