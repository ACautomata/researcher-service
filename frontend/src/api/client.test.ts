// seam: API client —— JWT 拦截 + 401 清会话（spec §9.1）。
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

  it('clears session and throws ApiError on 401', async () => {
    const auth = useAuthStore()
    auth.token = 'tok'
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp('', 401))
    await expect(apiFetch('/api/v1/x')).rejects.toBeInstanceOf(ApiError)
    expect(auth.token).toBe('')
    // codex R1 :102：401 仅清 access token，不标 refreshExhausted——交由 hydrate 用
    // refresh 端点真实结果决定耗尽（access 过期但 refresh cookie 仍有效时不被迫重登）
    expect(auth.refreshExhausted).toBe(false)
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
