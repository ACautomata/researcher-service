// chat WS 客户端（issue #41 / spec §8.4）：原生 WebSocket + JWT subprotocol。
// 经 /ws/chat/ 连后端 ChatConsumer（握手复用 T02 JwtAuthMiddleware）；收 ready/text/done/error
// 分发到 handlers。无新依赖（不用 @vueuse/core），原生 WebSocket 即可满足 MVP。
//
// subprotocol 对齐 accounts/middleware._extract_token 格式 1：['access_token', <jwt>]。

export type ChatFrame =
  | { type: 'ready'; container: string }
  | { type: 'text'; runId: string; delta: string; replace?: boolean }
  | { type: 'done'; runId: string }
  | { type: 'error'; runId?: string; message: string; id?: string }
  | { type: 'approval'; id: string; kind: string; command: string; sessionKey: string | null }
  | { type: 'approvalResolved'; id: string; decision: string }
  | { type: 'tool'; runId: string; name: string; state: 'running' | 'done';
      title: string | null; input: unknown; result: unknown }

// T06 审批卡数据（连接级，无 runId；sessionKey 标识归属会话，codex P1）
export interface ApprovalCard {
  id: string
  kind: string
  command: string
  sessionKey: string | null
}

// T08 工具行（issue #44 / spec §9.4 / r26 §3）：工具挂在 chat run 内，带 runId；前端按 name 聚合
// start→result 渲染一行标题+状态。title/input/result 由网关 payload 透传（确切字段名待配对后实测校准，
// 见后端 chat.event_translate._translate_tool）。
export interface ToolLine {
  runId: string
  name: string
  state: 'running' | 'done'
  title: string | null
  input: unknown
  result: unknown
}

export interface ChatHandlers {
  onReady?: (container: string) => void
  onText?: (runId: string, delta: string, replace?: boolean) => void
  onDone?: (runId: string) => void
  onError?: (message: string, runId?: string, approvalId?: string) => void
  onClose?: () => void
  onApproval?: (card: ApprovalCard) => void
  onApprovalResolved?: (id: string, decision: string) => void
  onTool?: (tool: ToolLine) => void
}

export class ChatWebSocket {
  private readonly ws: WebSocket
  private readonly handlers: ChatHandlers
  // CONNECTING 期间 send() 会抛 InvalidStateError → 缓冲到 onopen 后 flush（codex P1）
  private readonly queue: Record<string, unknown>[] = []
  private opened = false
  private closed = false // onclose 后置位：后续 send 不再调原生 send（CLOSED 态抛 InvalidStateError）

  constructor(path: string, jwt: string, handlers: ChatHandlers) {
    this.handlers = handlers
    this.ws = new WebSocket(path, ['access_token', jwt])
    this.ws.onopen = () => {
      this.opened = true
      for (const frame of this.queue) this.ws.send(JSON.stringify(frame))
      this.queue.length = 0
    }
    this.ws.onmessage = this.handleMessage.bind(this)
    this.ws.onerror = () => this.handlers.onError?.('连接错误')
    this.ws.onclose = () => {
      this.closed = true
      this.handlers.onClose?.()
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  start(container: string): void {
    this.sendRaw({ type: 'start', container })
  }

  send(sessionKey: string, message: string): void {
    this.sendRaw({ type: 'send', sessionKey, message })
  }

  // T06：回覆一次权限审批（spec §8.2）
  resolve(id: string, kind: string, decision: string): void {
    this.sendRaw({ type: 'resolve', id, kind, decision })
  }

  close(): void {
    this.ws.close()
  }

  private sendRaw(frame: Record<string, unknown>): void {
    if (this.closed) {
      // socket 已关（代理/后端重启）：不再调原生 send（会抛 InvalidStateError 且不触发 handler），
      // 改走 onError 让视图提示并收尾 streaming bubble（codex P2）。
      this.handlers.onError?.('连接已断开，请重试或切换容器')
      return
    }
    if (this.opened) {
      this.ws.send(JSON.stringify(frame))
    } else {
      this.queue.push(frame) // CONNECTING 期间缓冲，onopen 后 flush
    }
  }

  private handleMessage(ev: MessageEvent): void {
    const frame = JSON.parse(ev.data as string) as ChatFrame
    switch (frame.type) {
      case 'ready':
        this.handlers.onReady?.(frame.container)
        break
      case 'text':
        this.handlers.onText?.(frame.runId, frame.delta, frame.replace)
        break
      case 'done':
        this.handlers.onDone?.(frame.runId)
        break
      case 'error':
        this.handlers.onError?.(frame.message, frame.runId, frame.id)
        break
      case 'approval':
        this.handlers.onApproval?.({
          id: frame.id, kind: frame.kind, command: frame.command, sessionKey: frame.sessionKey,
        })
        break
      case 'approvalResolved':
        this.handlers.onApprovalResolved?.(frame.id, frame.decision)
        break
      case 'tool':
        this.handlers.onTool?.({
          runId: frame.runId, name: frame.name, state: frame.state,
          title: frame.title, input: frame.input, result: frame.result,
        })
        break
    }
  }
}
