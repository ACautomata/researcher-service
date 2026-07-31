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
  | { type: 'tool'; runId: string; name: string; state: 'running' | 'done' | 'error';
      id: string | null; title: string | null; input: unknown; result: unknown }

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
  state: 'running' | 'done' | 'error'
  id: string | null // 工具调用 id（同名并发调用按 id 配对 result，无 id 退 name）
  title: string | null
  input: unknown
  result: unknown
}

export interface ChatHandlers {
  onReady?: (container: string) => void
  onText?: (runId: string, delta: string, replace?: boolean) => void
  onDone?: (runId: string) => void
  onError?: (message: string, runId?: string, approvalId?: string) => void
  // onClose 透传 CloseEvent.code/reason（4401 = JWT 过期等应用私有码，供视图判定重连/刷新，issue #237）
  onClose?: (code?: number, reason?: string) => void
  onApproval?: (card: ApprovalCard) => void
  onApprovalResolved?: (id: string, decision: string) => void
  onTool?: (tool: ToolLine) => void
}

// 断线/CLOSED/CLOSING 态 send 的统一收尾文案（sendRaw 守卫收尾，issue #237）
const DISCONNECTED_MSG = '连接已断开，请重试或切换容器'

export class ChatWebSocket {
  private readonly ws: WebSocket
  private readonly handlers: ChatHandlers
  // CONNECTING 期间 send() 会抛 InvalidStateError → 缓冲到 onopen 后 flush（codex P1）
  private readonly queue: Record<string, unknown>[] = []
  private opened = false
  private closed = false // onclose 后置位：sendRaw 不再调原生 send，走 onError 收尾（codex P2）

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
    this.ws.onclose = (ev: CloseEvent) => {
      this.closed = true
      // 透传 code/reason：视图用 code=4401（JWT 过期）等应用私有码区分断线原因（issue #237）
      this.handlers.onClose?.(ev.code, ev.reason)
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
    // 守卫而非 try/catch：原生 WebSocket.send() 仅在 CONNECTING 抛 InvalidStateError，
    // CLOSING/CLOSED 是静默丢弃不抛错（WHATWG #dom-websocket-send）→ try/catch 捕不到 CLOSING
    // 竞态，消息会从 composer 清空但帧没发出。改用 readyState 判走 onError 收尾（codex P2）。
    if (this.closed || (this.opened && this.ws.readyState !== WebSocket.OPEN)) {
      // closed：onclose 已触发（代理/后端重启/连接失败）——直接收尾；
      // opened && CLOSING/CLOSED：close() 后、onclose 前窗口——原生静默丢弃，与 CLOSED 同走 onError。
      this.handlers.onError?.(DISCONNECTED_MSG)
      return
    }
    if (this.opened) {
      this.ws.send(JSON.stringify(frame))
    } else {
      this.queue.push(frame) // CONNECTING 期间缓冲，onopen 后 flush
    }
  }

  private handleMessage(ev: MessageEvent): void {
    // 畸形 JSON / 非 JSON 文本帧：仅 warn 后丢弃，不抛未捕获异常、不中断后续帧分发（issue #237）
    let frame: ChatFrame
    try {
      frame = JSON.parse(ev.data as string) as ChatFrame
    } catch {
      console.warn('[chat-ws] 丢弃畸形 WS 帧（非 JSON）：', ev.data)
      return
    }
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
          id: frame.id ?? null, title: frame.title, input: frame.input, result: frame.result,
        })
        break
    }
  }
}
