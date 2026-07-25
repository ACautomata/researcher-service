// chat WS 客户端（issue #41 / spec §8.4）：原生 WebSocket + JWT subprotocol。
// 经 /ws/chat/ 连后端 ChatConsumer（握手复用 T02 JwtAuthMiddleware）；收 ready/text/done/error
// 分发到 handlers。无新依赖（不用 @vueuse/core），原生 WebSocket 即可满足 MVP。
//
// subprotocol 对齐 accounts/middleware._extract_token 格式 1：['access_token', <jwt>]。

export type ChatFrame =
  | { type: 'ready'; container: string }
  | { type: 'text'; runId: string; delta: string }
  | { type: 'done'; runId: string }
  | { type: 'error'; runId?: string; message: string }

export interface ChatHandlers {
  onReady?: (container: string) => void
  onText?: (runId: string, delta: string) => void
  onDone?: (runId: string) => void
  onError?: (message: string) => void
  onClose?: () => void
}

export class ChatWebSocket {
  private readonly ws: WebSocket
  private readonly handlers: ChatHandlers

  constructor(path: string, jwt: string, handlers: ChatHandlers) {
    this.handlers = handlers
    this.ws = new WebSocket(path, ['access_token', jwt])
    this.ws.onmessage = this.handleMessage.bind(this)
    this.ws.onerror = () => this.handlers.onError?.('连接错误')
    this.ws.onclose = () => this.handlers.onClose?.()
  }

  start(container: string): void {
    this.sendRaw({ type: 'start', container })
  }

  send(sessionKey: string, message: string): void {
    this.sendRaw({ type: 'send', sessionKey, message })
  }

  close(): void {
    this.ws.close()
  }

  private sendRaw(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame))
  }

  private handleMessage(ev: MessageEvent): void {
    const frame = JSON.parse(ev.data as string) as ChatFrame
    switch (frame.type) {
      case 'ready':
        this.handlers.onReady?.(frame.container)
        break
      case 'text':
        this.handlers.onText?.(frame.runId, frame.delta)
        break
      case 'done':
        this.handlers.onDone?.(frame.runId)
        break
      case 'error':
        this.handlers.onError?.(frame.message)
        break
    }
  }
}
