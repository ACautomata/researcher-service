// API client —— JWT 拦截 + 401 刷新重试/跳登录（spec §9.1）。
// 所有需认证请求经 apiFetch/apiJson：自动注入 Authorization Bearer；
// 401 时先用 httpOnly refresh cookie 换新并重试一次，刷新失败才清会话并跳登录（codex R2）。
import { useAuthStore } from '@/stores/auth'
import { ApiError } from '@/api/errors'
import { timeoutSignal } from '@/api/timeout'

// #202 问题5：ApiError 唯一定义在 api/errors.ts（status 可选），此处 re-export 保持
// 既有 `from '@/api/client'` 导入兼容——instanceof 行为与导入源无关。
export { ApiError }

function buildHeaders(init: RequestInit, token: string): Headers {
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return headers
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const auth = useAuthStore()
  // 统一 15s 超时（#202 问题4）：悬挂请求到期 abort，调用方已自带 signal 时沿用
  const timed: RequestInit = { ...init, signal: init.signal ?? timeoutSignal() }
  let resp = await fetch(path, { ...timed, headers: buildHeaders(timed, auth.token) })
  if (resp.status !== 401) return resp

  // 服务端已拒绝当前 access；即使本地 exp 尚未到期，也必须强制用 refresh cookie 换新。
  await auth.forceRefresh()
  if (auth.token) {
    resp = await fetch(path, { ...timed, headers: buildHeaders(timed, auth.token) })
    if (resp.status !== 401) return resp
  }
  // codex R8 F2：区分「确认拒绝」与「瞬态失败」。forceRefresh 对 refresh 端点 4xx 标
  // refreshExhausted（cookie 确认失效），对网络异常/5xx 不标（cookie 仍可能有效）。
  // 仅确认拒绝才清会话跳登录；瞬态失败保留会话供上层重试，避免 auth 服务临时中断即踢人。
  if (auth.refreshExhausted) {
    auth.clearSession()
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.assign('/login')
    }
  }
  throw new ApiError('未登录或登录已过期', 401)
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const resp = await apiFetch(path, init)
  if (!resp.ok) {
    let detail = `请求失败 (${resp.status})`
    try {
      const body = await resp.json()
      if (body && typeof body.detail === 'string') detail = body.detail
    } catch {
      // 无 JSON body，沿用默认 detail
    }
    throw new ApiError(detail, resp.status)
  }
  // #202 问题6：204/空体无 JSON 可解析，直接返回 undefined 而非让 resp.json() reject
  if (resp.status === 204) return undefined as T
  try {
    return (await resp.json()) as T
  } catch {
    return undefined as T
  }
}
