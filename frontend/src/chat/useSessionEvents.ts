import { apiJson } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type { SessionEvent } from './teamProjection'

const names = ['stream.opened', 'session.created', 'session.updated', 'session.invalidated', 'session.terminated', 'run.started', 'run.resumed', 'run.completed', 'run.failed', 'run.aborted', 'run.suspended', 'text.delta', 'thinking.delta', 'tool.start', 'tool.end', 'attachment', 'approval.requested', 'approval.resolved', 'teammate.started', 'teammate.completed', 'teammate.failed', 'teammate.suspended', 'teammate.archived']

export function openSessionEvents(onEvent: (event: SessionEvent) => void, onDisconnected: () => void, onGap: () => void = onDisconnected): () => void {
  let source: EventSource
  let closed = false
  let probing = false
  let lastSeq = -1
  const close = () => { closed = true; source.close() }
  function connect() {
    source = new EventSource('/api/v1/events')
    const current = source
    for (const name of names) current.addEventListener(name, raw => {
      if (closed || current !== source) return
      const message = raw as MessageEvent<string>
      let event: SessionEvent
      try { event = JSON.parse(message.data) as SessionEvent } catch { return }
      if (!event || typeof event.type !== 'string' || !event.payload || typeof event.payload !== 'object') return
      const seq = message.lastEventId ? Number(message.lastEventId) : NaN
      if (event.type !== 'stream.opened' && Number.isFinite(seq)) {
        if (seq <= lastSeq) return
        if (lastSeq >= 0 && seq > lastSeq + 1) onGap()
      }
      if (Number.isFinite(seq)) lastSeq = seq
      if (event.type === 'session.terminated' && !event.sessionId) close()
      onEvent(event)
    })
    current.onerror = () => {
      if (closed || current !== source) return
      onDisconnected()
      if (probing) return
      probing = true
      // EventSource hides HTTP 401; use the shared REST refresh chain before reopening.
      void apiJson('/api/v1/auth/me').then(() => {
        if (!closed && current === source && current.readyState === 2) { current.close(); connect() }
      }).catch(() => {
        if (useAuthStore().refreshExhausted) close()
      }).finally(() => { probing = false })
    }
  }
  connect()
  return close
}
