// #337 M5 隧道：容器网关连接 Port（测试接缝 3 WS 桥）。
// 后端隧道 = 浏览器↔面板一条 WS（JWT 归属门握手），建立后原样透传浏览器↔容器网关的
// OpenClaw 协议 v4 原始帧。本文件是「面板→容器网关」这条腿的传输层接缝：
//   生产 = makeWsGatewayConnector（Node ws 客户端连宿主 ws://<host>:<port>/）；
//   测试 = 注入内存 fake（断言帧字节级透传 + 零解析）。
// GatewaySocket 接口按官方 ./browser 协议机的纯文本帧契约设计（send/message 均为 string，
// 协议 v4 帧为 JSON 文本）。协议 v4 握手/重连/会话投影全由浏览器侧官方包负责，后端零解析。

import WebSocket from 'ws'

// 一个到容器网关的传输 socket（方向：后端⇄网关）。onMessage 即网关发来的原始协议帧。
export interface GatewaySocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  onOpen(cb: () => void): void
  onMessage(cb: (data: string) => void): void
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
        const ws = new WebSocket(url)
        const timer = setTimeout(() => {
          ws.terminate()
          reject(new Error(`gateway connect timeout: ${url}`))
        }, timeoutMs)
        // connect 阶段错误 → reject；连接建立后的错误交给 onError（透传层决定是否关隧道）。
        const onConnectError = (err: Error): void => {
          clearTimeout(timer)
          reject(err)
        }
        let msgCb: ((data: string) => void) | null = null
        const buffered: string[] = []
        ws.on('message', (data) => {
          const text = data.toString()
          if (msgCb) msgCb(text)
          else buffered.push(text)
        })
        ws.once('open', () => {
          clearTimeout(timer)
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
            onOpen: (cb) => ws.on('open', cb),
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
        ws.once('error', onConnectError)
      })
    },
  }
}
