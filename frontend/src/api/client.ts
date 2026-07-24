// API client —— JWT 拦截 + 401 刷新重试/跳登录（spec §9.1）。
// 所有需认证请求经 apiFetch/apiJson：自动注入 Authorization Bearer；
// 401 时先用 httpOnly refresh cookie 换新并重试一次，刷新失败才清会话并跳登录（codex R2）。
import { useAuthStore } from '@/stores/auth'

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

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
  let resp = await fetch(path, { ...init, headers: buildHeaders(init, auth.token) })
  if (resp.status !== 401) return resp

  // codex R2 :26：access 过期但 httpOnly refresh cookie 可能仍有效——先 hydrate 换新并重试，
  // 而非直接清会话干等用户手动刷新（单受保护路由下 guard 不会再次 hydrate，否则卡死重登）。
  await auth.hydrate()
  if (auth.token) {
    resp = await fetch(path, { ...init, headers: buildHeaders(init, auth.token) })
    if (resp.status !== 401) return resp
  }
  // 刷新也失败/无 refresh：清本地登录态并显式跳登录（无人观察状态变化，须主动导航）。
  auth.clearSession()
  if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
    window.location.assign('/login')
  }
  throw new ApiError(401, '未登录或登录已过期')
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
    throw new ApiError(resp.status, detail)
  }
  return resp.json() as Promise<T>
}
