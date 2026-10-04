import { createPinia, setActivePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { openSessionEvents } from './useSessionEvents'
class Stream extends EventTarget {
  static instances: Stream[] = []
  readyState = 1
  onerror: (() => void) | null = null
  close = vi.fn()
  constructor() { super(); Stream.instances.push(this) }
  emit(type: string, seq: number) { this.dispatchEvent(new MessageEvent(type, { lastEventId: String(seq), data: JSON.stringify({ type, payload: {} }) })) }
}
afterEach(() => { vi.unstubAllGlobals(); Stream.instances = [] })
it('reconciles sequence gaps and reopens a closed stream after REST authentication succeeds', async () => {
  setActivePinia(createPinia())
  vi.stubGlobal('EventSource', Stream)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 0, message: '', data: {} }), { headers: { 'Content-Type': 'application/json' } })))
  const onEvent = vi.fn(); const gap = vi.fn()
  const stop = openSessionEvents(onEvent, vi.fn(), gap)
  const first = Stream.instances[0]!
  first.emit('stream.opened', 1); first.emit('text.delta', 3); first.emit('text.delta', 3)
  expect(gap).toHaveBeenCalledOnce(); expect(onEvent).toHaveBeenCalledTimes(2)
  first.readyState = 2; first.onerror?.()
  await vi.waitFor(() => expect(Stream.instances).toHaveLength(2))
  stop(); expect(Stream.instances[1]!.close).toHaveBeenCalledOnce()
  first.emit('text.delta', 4); expect(onEvent).toHaveBeenCalledTimes(2)
})
