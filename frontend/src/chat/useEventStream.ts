// useEventStream —— SSE 事件流薄封装（#730 §4.1 M1 核心 / #726 事件模型）。
// 原生 EventSource + `panel_stream` cookie（HttpOnly/SameSite=Strict，login/refresh Set-Cookie
// 滑动续期）；EventSource 断线自带重连（白送），本层只补四件事：
//   1. gap 检测：serverSeq（Last-Event-ID）只检测不重放——服务端从不上行重放（#773 StreamHub
//      fire-and-forget），断线补偿 = 投影重拉，onGap 交编排层决定；
//   2. 401 关流：EventSource 看不见 HTTP 状态码（#726 钉死）——onerror 后经共享 REST 刷新链
//      探测 /auth/me，刷新链死（refreshExhausted）→ 主动 close 停重连；
//   3. session.terminated 停重连：per-user 广播（reason logout/revoked，无 sessionId）→ close。
//   4. error 不停重连（连接域第三成员，#747 C 节定稿目录）：带内错误帧 = 流级服务端错误通知，
//      服务端 publishError 不关连接（区别 terminate 的停重连），帧占一个 seq 保游标连续
//      （payload {code:5xxxx}，准据 #726 resolution）——本层落 console.warn 提示（最保守
//      既有路径，不造新 UI），帧照常透传 onEvent。
// 纯传输面：不解析业务事件（SessionEvent 透传）、不持会话状态——归投影归约器/编排 composable。
import { ref, type Ref } from 'vue'
import { apiJson } from '@/api/client'
import { useAuthStore } from '@/stores/auth'

// SSE 事件目录（server events/logic.ts type 面）：type 自由串 + 路由字段（sessionId/runId/
// teammateId）+ payload——非判别联合，消费方按 type 分派（投影归约器/编排层同款）。
export interface SessionEvent {
  type: string
  sessionId?: string
  teammateId?: string
  runId?: string
  payload: Record<string, unknown>
}

export type EventStreamStatus = 'connecting' | 'open' | 'disconnected' | 'closed'

// 订阅目录（server 事件全集；teammate.archived 服务端当前不发，保留向前兼容）。
// 'error' 与 EventSource 原生连接错误事件同名：named 帧（MessageEvent 带 data JSON）走
// 目录分派；原生断线错误（plain Event 无 data）被坏帧守卫丢弃，断线语义仍归 onerror。
const EVENT_NAMES = [
  'stream.opened', 'error', 'session.created', 'session.updated', 'session.invalidated',
  'session.terminated', 'run.started', 'run.resumed', 'run.completed', 'run.failed',
  'run.aborted', 'run.suspended', 'text.delta', 'thinking.delta', 'tool.start', 'tool.end',
  'attachment', 'figure_run.progress', 'approval.requested', 'approval.resolved',
  'teammate.started', 'teammate.completed', 'teammate.failed', 'teammate.suspended',
  'teammate.archived', 'wiki_run.progress', 'wiki_run.text', 'wiki_run.tool_start',
  'wiki_run.tool_end', 'wiki_run.finished',
] as const

export interface EventStreamHandlers {
  onEvent(event: SessionEvent): void
  /** 流打开（含每次重连成功）——编排层挂钩断线补偿（投影重拉 + 待发注入） */
  onOpen?(): void
  onDisconnect?(): void
  onGap?(): void
}

export interface EventStream {
  /** connecting → open ⇄ disconnected；closed = 终态（terminated/刷新链死），不再重连 */
  readonly status: Ref<EventStreamStatus>
  close(): void
}

export function useEventStream(handlers: EventStreamHandlers): EventStream {
  const status = ref<EventStreamStatus>('connecting')
  let source: EventSource | null = null
  let closed = false // close() 后恒 true：所有回调短路，不再重连
  let probing = false // 401 探测单飞（onerror 对一次断线可能连发）
  let lastSeq = -1

  function close(): void {
    closed = true
    status.value = 'closed'
    source?.close()
    source = null
  }

  function connect(): void {
    if (closed) return
    status.value = 'connecting'
    const next = new EventSource('/api/v1/events')
    source = next
    for (const name of EVENT_NAMES) {
      next.addEventListener(name, (raw) => {
        // 迟到帧：已 close 或已被更新的连接替换 → 丢弃
        if (closed || source !== next) return
        const message = raw as MessageEvent<string>
        let event: SessionEvent
        try {
          event = JSON.parse(message.data) as SessionEvent
        } catch {
          return // 坏帧丢弃（0 信任读回）
        }
        if (!event || typeof event.type !== 'string' || !event.payload || typeof event.payload !== 'object') return
        // seq 去重 + gap 检测（stream.opened 无 seq；Last-Event-ID 只检测不重放）
        const seq = message.lastEventId ? Number(message.lastEventId) : NaN
        if (event.type !== 'stream.opened' && Number.isFinite(seq)) {
          if (seq <= lastSeq) return // 重连重放/乱序重复帧
          if (lastSeq >= 0 && seq > lastSeq + 1) handlers.onGap?.()
        }
        if (Number.isFinite(seq)) lastSeq = seq
        if (event.type === 'stream.opened') {
          status.value = 'open'
          handlers.onOpen?.()
        }
        // session.terminated 是 per-user 广播（无 sessionId）+ 服务端随帧关流——停重连，
        // 其余回调不再触发（吊销/登出语义，REST 面会自行走 401 链）。
        if (event.type === 'session.terminated' && !event.sessionId) {
          close()
          return
        }
        // error 是连接域第三成员（#747 C 节，连接域事件不带 sessionId）——服务端带内
        // 错误信号（hub.publishError，payload {code:5xxxx}）：契约语义不关连接（区别
        // terminate 的停重连），帧占一个 seq 保游标连续。本层落 console.warn 提示
        // （最保守既有路径，不造新 UI）后不 return——帧照常透传 onEvent（连接域帧不带
        // sessionId，编排层分派自行忽略），连接继续、后续帧仍可收。
        if (event.type === 'error') {
          console.warn('[event-stream] 服务端错误帧, code =', event.payload.code)
        }
        handlers.onEvent(event)
      })
    }
    next.onerror = () => {
      if (closed || source !== next) return
      status.value = 'disconnected'
      handlers.onDisconnect?.()
      if (probing) return
      probing = true
      // EventSource 隐藏 HTTP 401：经共享 REST 刷新链探测——apiJson('/auth/me') 命中 401 时
      // 内部先 forceRefresh 重试，刷新链死（refreshExhausted）才抛错。活着 → EventSource 若已
      // 彻底关闭（readyState CLOSED，原生重连放弃）则手动重开；活着且还在重连则交还原生机制。
      void apiJson('/api/v1/auth/me')
        .then(() => {
          if (!closed && source === next && next.readyState === EventSource.CLOSED) {
            next.close()
            connect()
          }
        })
        .catch(() => {
          if (useAuthStore().refreshExhausted) close()
        })
        .finally(() => {
          probing = false
        })
    }
  }

  connect()
  return { status, close }
}
