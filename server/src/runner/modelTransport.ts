import { AsyncLocalStorage } from 'node:async_hooks'
import { presetById } from '../models/presets'

interface ModelTransport {
  signal: AbortSignal
  pending: Set<Promise<unknown>>
  purpose?: 'next-step-suggestion'
}

const currentTransport = new AsyncLocalStorage<ModelTransport>()
const deepSeekBaseUrl = presetById('deepseek')?.baseUrl
const deepSeekOrigin = deepSeekBaseUrl && new URL(deepSeekBaseUrl).origin

// SDK 的 invoke 可能先于传输结束。建议生成持有执行槽，直到已发起的请求及响应体收尾。
export function withModelTransport<T>(
  signal: AbortSignal,
  invoke: () => Promise<T>,
  options: Pick<ModelTransport, 'purpose'> = {},
): Promise<T> {
  const lifetime = new AbortController()
  const transport: ModelTransport = { signal: AbortSignal.any([signal, lifetime.signal]), pending: new Set(), purpose: options.purpose }
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

// 官方 DeepSeek Chat Completions 的推理 token 共用短输出预算。按每跳实际 URL 判断，
// 避免同一模型快照内的 fallback 把 DeepSeek 参数发给其他兼容服务。
function deepSeekSuggestionBody(input: Parameters<typeof fetch>[0], body: string): string {
  const url = URL.parse(input instanceof Request ? input.url : String(input))
  if (!url || url.origin !== deepSeekOrigin || !/^\/(v1\/)?chat\/completions$/.test(url.pathname)) return body
  const payload = JSON.parse(body)
  return JSON.stringify({ ...payload, thinking: { type: 'disabled' } })
}

export function trackModelFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const transport = currentTransport.getStore()
    if (!transport) return fetchImpl(input, init)
    transport.signal.throwIfAborted()
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const signal = requestSignal ? AbortSignal.any([requestSignal, transport.signal]) : transport.signal
    return track(transport, (async () => {
      const request = { ...init, signal }
      if (transport.purpose === 'next-step-suggestion' && typeof request.body === 'string') {
        request.body = deepSeekSuggestionBody(input, request.body)
      }
      const response = await fetchImpl(input, request)
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
