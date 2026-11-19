import { AsyncLocalStorage } from 'node:async_hooks'

interface ModelTransport {
  signal: AbortSignal
  pending: Set<Promise<unknown>>
}

const currentTransport = new AsyncLocalStorage<ModelTransport>()

// SDK 的 invoke 可能先于传输结束。建议生成持有执行槽，直到已发起的请求及响应体收尾。
export function withModelTransport<T>(signal: AbortSignal, invoke: () => Promise<T>): Promise<T> {
  const lifetime = new AbortController()
  const transport: ModelTransport = { signal: AbortSignal.any([signal, lifetime.signal]), pending: new Set() }
  return currentTransport.run(transport, async () => {
    try {
      return await invoke()
    } finally {
      lifetime.abort()
      await Promise.allSettled(transport.pending)
    }
  })
}

function track<T>(transport: ModelTransport, pending: Promise<T>): Promise<T> {
  transport.pending.add(pending)
  const remove = () => { transport.pending.delete(pending) }
  void pending.then(remove, remove)
  return pending
}

export function trackModelFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const transport = currentTransport.getStore()
    if (!transport) return fetchImpl(input, init)
    transport.signal.throwIfAborted()
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const signal = requestSignal ? AbortSignal.any([requestSignal, transport.signal]) : transport.signal
    return track(transport, (async () => {
      const response = await fetchImpl(input, { ...init, signal })
      if (!response.body) return response
      if (signal.aborted) {
        await response.body.cancel()
        signal.throwIfAborted()
      }
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
      track(transport, response.body.pipeTo(writable, { signal }))
      const tracked = new Response(readable, response)
      Object.defineProperties(tracked, {
        url: { value: response.url },
        redirected: { value: response.redirected },
        type: { value: response.type },
      })
      return tracked
    })())
  }
}
