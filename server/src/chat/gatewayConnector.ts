// #337 M5 隧道：容器网关连接 Port（测试接缝 3 WS 桥）。
// 后端隧道 = 浏览器↔面板一条 WS（JWT 归属门握手），建立后原样透传浏览器↔容器网关的
// OpenClaw 协议 v4 原始帧。本文件是「面板→容器网关」这条腿的传输层接缝：
//   生产 = makeWsGatewayConnector（Node ws 客户端连宿主 ws://<host>:<port>/）；
//   测试 = 注入内存 fake（断言帧字节级透传 + 零解析）。
// GatewaySocket 接口按官方 ./browser 协议机的纯文本帧契约设计（send/message 均为 string，
// 协议 v4 帧为 JSON 文本）。协议 v4 握手/重连/会话投影全由浏览器侧官方包负责，后端零解析。

import WebSocket from 'ws'
import {
  TUNNEL_MAX_PAYLOAD,
  TUNNEL_SEND_BUDGET,
  TUNNEL_PENDING_BYTE_BUDGET,
  WS_POLICY_VIOLATION,
} from './values'

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
export function makeWsGatewayConnector(timeoutMs = CONNECT_TIMEOUT_MS, sendBudget = TUNNEL_SEND_BUDGET): GatewayConnector {
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
        const removeConnectListeners = (): void => {
          ws.removeListener('error', onConnectError)
          ws.removeListener('close', onConnectClose)
        }
        const onConnectError = (err: Error): void => {
          clearTimeout(timer)
          removeConnectListeners()
          reject(err)
        }
        // F13: 打开握手中的 close-before-open（网关 reset TCP 时不触发 'error'）——也须清除超时
        // 定时器并 reject，否则快速拒绝被误报为「gateway connect timeout」（4402 延迟 5s）。
        const onConnectClose = (): void => {
          clearTimeout(timer)
          removeConnectListeners()
          reject(new Error(`gateway connect closed before open: ${url}`))
        }
        ws.on('error', onConnectError)
        ws.on('close', onConnectClose)
        let msgCb: ((data: string | Buffer) => void) | null = null
        // F13: connect 阶段缓冲也须有字节上限——健谈的网关可在 open→resolve→注册窗口内推送无界帧
        // 打满面板进程堆（browser→gateway 方向有 TUNNEL_PENDING_BYTE_BUDGET，此方向此前无）。超限
        // terminate + reject（隧道层按网关不可达 4402 决策）。
        let bufferedBytes = 0
        const buffered: Array<string | Buffer> = []
        ws.on('message', (data, isBinary) => {
          // #9：文本帧 toString（无损）；二进制帧原样 Buffer——Node ws 默认 binaryType=nodebuffer，
          // isBinary 时 data 即原始字节。toString 会把 0xff/0x80 有损为 U+FFFD mojibake 并以文本帧
          // 重发，违背「字节管道」契约。
          const frame = isBinary ? (data as Buffer) : (data as Buffer).toString()
          if (msgCb) msgCb(frame)
          else {
            bufferedBytes += (data as Buffer).length
            if (bufferedBytes > TUNNEL_PENDING_BYTE_BUDGET) {
              // #15（第四轮）：ws 的 'message' 恒在 'open' 之后 → 此刻 promise 多已 resolve，reject 是
              // no-op；真正的保护是 ws.terminate()（kill 已 resolve 的 socket → tunnel onClose → 隧道按
              // 4402 网关不可达决策）。reject 保留作防御性兜底（极端时序下 promise 未 settle 时仍生效）。
              clearTimeout(timer)
              removeConnectListeners()
              ws.terminate()
              reject(new Error(`gateway connect buffer overflow (${bufferedBytes} bytes)`))
              return
            }
            buffered.push(frame)
          }
        })
        ws.once('open', () => {
          clearTimeout(timer)
          // 连接已建立：移除 connect 阶段处理器，post-open error 只走下方 onError（记录+重放）
          removeConnectListeners()
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
              if (ws.readyState !== WebSocket.OPEN) return
              // #4 P2：发送背压防护——网关读得慢时 ws.send 内部缓冲无界增长（TCP 背压），1MiB 级
              // 帧流可打满面板进程堆、影响所有租户。bufferedAmount = 未写入底层 socket 的待发字节，
              // 超预算即 close(1008)（策略违反）——close 经 tunnel onClose 传导浏览器，协议机决策
              // 重连。pending 预算(256KiB)只保护连接建立窗口，此为 post-connect 转发路径的守卫。
              const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data)
              if (ws.bufferedAmount + size > sendBudget) {
                ws.close(WS_POLICY_VIOLATION)
                return
              }
              ws.send(data)
            },
            close: (code, reason) => ws.close(code, reason),
            onMessage: (cb) => {
              msgCb = cb
              for (const frame of buffered) cb(frame)
              buffered.length = 0
              bufferedBytes = 0 // #15：flush 后归零（flush 后不再读，但保持与 buffered 一致，避免残留误读）
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
