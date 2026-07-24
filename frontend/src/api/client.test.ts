// seam: API client —— JWT 拦截 + 401 刷新重试/跳登录（spec §9.1）。
// 出处：docs/FULLSTACK-REFACTOR-SPEC.md §9.1（API client 封装 JWT 拦截器，401 刷新/跳登录）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { apiFetch, apiJson, ApiError } from '@/api/client'

function mockResp(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response
}

// 未过期 JWT（exp 远大于现在）：header.payload.signature，payload 仅含 exp
function liveToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))
    .replace(/=+$/, '')
  return `h.${payload}.s`
}

describe('api client', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn())
  })

  it('attaches JWT Bearer header when authenticated', async () => {
    useAuthStore().token = 'tok-abc'
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp('[]'))
    await apiFetch('/api/v1/x')
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer tok-abc')
  })

  it('omits Authorization header when no token', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp('{}'))
    await apiFetch('/api/v1/x')
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect((init.headers as Headers).get('Authorization')).toBeNull()
  })

  it('sets JSON Content-Type when a body is present', async () => {
    useAuthStore().token = 't'
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp('{}'))
    await apiFetch('/api/v1/x', { method: 'POST', body: '{"a":1}' })
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json')
  })

  it('refreshes via cookie and retries once on 401 (codex R2 :26)', async () => {
    // access 过期但 httpOnly refresh cookie 仍有效：hydrate 换新后须用新 token 重试成功，
    // 而非清会话干等用户手动刷新（单受保护路由下 guard 不会再次 hydrate）。
    const auth = useAuthStore()
    auth.token = 'expired-access'
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(mockResp('', 401)) // 原请求 401
      .mockResolvedValueOnce(mockResp({ access: liveToken() }, 200)) // refresh 成功
      .mockResolvedValueOnce(mockResp('[]', 200)) // 重试成功
    const resp = await apiFetch('/api/v1/x')
    expect(resp.status).toBe(200)
    expect(auth.token).not.toBe('expired-access')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // 重试用的是 refresh 换到的新 token
    const retryInit = fetchMock.mock.calls[2][1] as RequestInit
    expect((retryInit.headers as Headers).get('Authorization')).toBe(`Bearer ${auth.token}`)
  })

  it('clears session, redirects, and throws when refresh also fails on 401', async () => {
    const auth = useAuthStore()
    auth.token = 'expired-access'
    // 原请求 + refresh 全 401：refresh 端点确认 cookie 失效 → 清会话 + 跳登录 + 抛错
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp('', 401))
    const assignSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/', assign: assignSpy },
    })
    await expect(apiFetch('/api/v1/x')).rejects.toBeInstanceOf(ApiError)
    expect(auth.token).toBe('')
    expect(assignSpy).toHaveBeenCalledWith('/login')
  })

  it('apiJson returns parsed body on 2xx', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({ a: 1 }))
    expect(await apiJson<{ a: number }>('/x')).toEqual({ a: 1 })
  })

  it('apiJson throws ApiError with backend detail on non-2xx', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ detail: '非法 name' }, 400),
    )
    await expect(apiJson('/x')).rejects.toThrow('非法 name')
  })
})
