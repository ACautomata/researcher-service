// API client —— JWT 拦截 + 401 清会话（spec §9.1）。
// 所有需认证请求经 apiFetch/apiJson：自动注入 Authorization Bearer；401 时清登录态（交路由守卫重定向）。
import { useAuthStore } from '@/stores/auth'

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const auth = useAuthStore()
  const headers = new Headers(init.headers)
  if (auth.token) headers.set('Authorization', `Bearer ${auth.token}`)
  if (init.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const resp = await fetch(path, { ...init, headers })
  if (resp.status === 401) {
    // token 失效/被吊销：清本地登录态，路由守卫下次导航重定向登录（codex T03）
    auth.clearSession()
    throw new ApiError(401, '未登录或登录已过期')
  }
  return resp
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
