// 前端 HTTP 请求统一超时。AbortSignal.timeout 让永久无响应的 fetch 以瞬态网络错误结束；
// 调用方已有 signal 时用 AbortSignal.any 同时保留主动取消语义。
export const REQUEST_TIMEOUT_MS = 15_000

export function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  return fetch(input, { ...init, signal })
}
