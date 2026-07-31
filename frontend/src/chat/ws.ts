// chat WS 客户端（issue #41 / spec §8.4）：原生 WebSocket + JWT subprotocol。
// 经 /ws/chat/ 连后端 ChatConsumer（握手复用 T02 JwtAuthMiddleware）；收 ready/text/done/error
// 分发到 handlers。无新依赖（不用 @vueuse/core），原生 WebSocket 即可满足 MVP。
//
// subprotocol 对齐 accounts/middleware._extract_token 格式 1：['access_token', <jwt>]。

export type ChatFrame =
  | { type: 'ready'; container: string }
  | { type: 'pong' } // codex #249 P1：心跳应答（无业务载荷；入站即重置静默看门狗，switch 无需分发）
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

// issue #239 / 评审 #198 问题 1 + codex #249 P1：浏览器↔Channels 腿的应用层心跳 + 静默看门狗。
// 本腿除 ready/业务事件外无周期帧（daphne 默认不发协议 ping；下游 30s tick 属 Django↔OpenClaw 腿，
// 与本腿无关）——若无活性流量，半开连接（网络抖动、反向代理 idle timeout 掐断，如 nginx 默认 60s）
// 要到下一次 send 才暴露。心跳：onopen 后每 PING_INTERVAL 发 {type:ping}，consumer 回 {type:pong}；
// 看门狗对**任意入站帧**（含 pong）重置——idle 健康连接因周期 pong 永不判死；只有连续 ping 无应答
// （真半开）静默超 SILENCE_TIMEOUT 才主动 close()，经既有 onClose 链路进 ChatView 退避重连（唯一入口）。
export const PING_INTERVAL_MS = 25_000 // < nginx 60s idle 掐断 & < SILENCE_TIMEOUT，保证 idle 也有活性流量
export const SILENCE_TIMEOUT_MS = 60_000 // 连续 ping 无应答才判死（≈2 个心跳周期无 pong）

export class ChatWebSocket {
  private readonly ws: WebSocket
  private readonly handlers: ChatHandlers
  // CONNECTING 期间 send() 会抛 InvalidStateError → 缓冲到 onopen 后 flush（codex P1）
  private readonly queue: Record<string, unknown>[] = []
  private opened = false
  private closed = false // onclose 后置位：sendRaw 不再调原生 send，走 onError 收尾（codex P2）
  // 静默看门狗定时器（issue #239）：open 后布防、每入站帧重置、close 时清除
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null
  // 应用层心跳定时器（codex #249 P1）：周期发 ping 给本腿提供活性流量
  private pingTimer: ReturnType<typeof setInterval> | null = null
  // 看门狗阈值/心跳间隔可注入（测试用短时钟），默认 SILENCE_TIMEOUT_MS / PING_INTERVAL_MS
  private readonly silenceTimeout: number
  private readonly pingInterval: number

  constructor(
    path: string,
    jwt: string,
    handlers: ChatHandlers,
    opts?: { silenceTimeoutMs?: number; pingIntervalMs?: number },
  ) {
    this.handlers = handlers
    this.silenceTimeout = opts?.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS
    this.pingInterval = opts?.pingIntervalMs ?? PING_INTERVAL_MS
    this.ws = new WebSocket(path, ['access_token', jwt])
    this.ws.onopen = () => {
      this.opened = true
      this.armWatchdog() // 连接建立即开始计时：对端从此静默超阈值即判死
      this.startHeartbeat() // 周期 ping：给本腿活性流量，idle 健康连接不被误判半开
      for (const frame of this.queue) this.ws.send(JSON.stringify(frame))
      this.queue.length = 0
    }
    this.ws.onmessage = this.handleMessage.bind(this)
    this.ws.onerror = () => this.handlers.onError?.('连接错误')
    this.ws.onclose = (ev: CloseEvent) => {
      this.closed = true
      this.clearTimers() // 连接已关：看门狗与心跳都无需再触发
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
    this.clearTimers() // 主动关闭：心跳与看门狗都不再触发，防定时器泄漏
    this.ws.close()
  }

  // 静默看门狗（issue #239）：布防/重置——每收到一帧（含 pong）即重置计时。静默超阈值判死：主动
  // close() 触发原生 onclose → ChatView 经既有 onClose 链路做退避重连（重连唯一入口）。
  private armWatchdog(): void {
    if (this.watchdogTimer !== null) clearTimeout(this.watchdogTimer)
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null
      this.close() // 半开判死：close() 经 onclose 上抛，进入重连链路
    }, this.silenceTimeout)
  }

  // 应用层心跳（codex #249 P1）：周期发 {type:ping}。本腿除 ready/业务事件外无周期帧——若无活性
  // 流量，idle 健康连接会被看门狗误判半开掐死；ping 的 pong 应答（入站帧）给看门狗周期性重置。
  // sendRaw 守卫：CLOSING/CLOSED 态 ping 走 onError 收尾，不抛 InvalidStateError。
  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.pingTimer = setInterval(() => {
      this.sendRaw({ type: 'ping' })
    }, this.pingInterval)
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private clearTimers(): void {
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
    }
    this.stopHeartbeat()
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
    this.armWatchdog() // 任何入站帧都证明对端存活：重置静默看门狗（issue #239）
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
