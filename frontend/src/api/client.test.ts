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

  it('forces refresh before retrying a locally unexpired token rejected with 401 (codex R5 :34)', async () => {
    const auth = useAuthStore()
    const rejectedToken = liveToken()
    const refreshedToken = `${liveToken()}-refreshed`
    auth.token = rejectedToken
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(mockResp('', 401))
      .mockResolvedValueOnce(mockResp({ access: refreshedToken }, 200))
      .mockResolvedValueOnce(mockResp('[]', 200))

    const resp = await apiFetch('/api/v1/x')

    expect(resp.status).toBe(200)
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/auth/token/refresh')
    const retryInit = fetchMock.mock.calls[2][1] as RequestInit
    expect((retryInit.headers as Headers).get('Authorization')).not.toBe(`Bearer ${rejectedToken}`)
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

  it('preserves session and stays on page on transient refresh failure (codex R8 F2)', async () => {
    // access 401 但 refresh 请求遇 5xx（auth 服务临时中断）：httpOnly refresh cookie 仍可能有效，
    // forceRefresh 已对 5xx/网络异常不标 refreshExhausted。apiFetch 不得因此清会话/跳登录踢人——
    // 须区分「确认拒绝（refreshExhausted）」与「瞬态失败」，后者仅抛错保留重试机会。
    const auth = useAuthStore()
    auth.token = 'expired-access'
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(mockResp('', 401)) // 原请求 401
      .mockResolvedValueOnce(mockResp('', 503)) // refresh 瞬态 5xx（非 4xx 确认拒绝）
    const assignSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/', assign: assignSpy },
    })

    await expect(apiFetch('/api/v1/x')).rejects.toBeInstanceOf(ApiError)

    expect(assignSpy).not.toHaveBeenCalled() // 不跳登录（会话可能仍有效）
    expect(auth.refreshExhausted).toBe(false) // 瞬态失败不标耗尽
    expect(fetchMock).toHaveBeenCalledTimes(2) // 原请求 + refresh；无 token 不重试
  })

  it('apiJson returns parsed body on 2xx', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({ a: 1 }))
    expect(await apiJson<{ a: number }>('/x')).toEqual({ a: 1 })
  })

  it('apiJson short-circuits on 204 empty body (issue #202 问题6)', async () => {
    // 204 No Content 无 body：resp.json() 会 reject，须直接短路返回
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 204,
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input')
      },
    } as unknown as Response)
    await expect(apiJson('/x', { method: 'DELETE' })).resolves.toBeUndefined()
  })

  it('apiFetch wraps requests with a 15s timeout signal (issue #202 问题4)', async () => {
    // 裸 fetch 无超时可永久悬挂；统一经 AbortSignal.timeout(15_000)
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp('{}'))
    await apiFetch('/api/v1/x')
    expect(timeoutSpy).toHaveBeenCalledWith(15_000)
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    timeoutSpy.mockRestore()
  })

  it('fetchWithTimeout respects a caller-provided signal over the default timeout', async () => {
    const { fetchWithTimeout } = await import('@/api/fetch')
    const ctrl = new AbortController()
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp('{}'))
    await fetchWithTimeout('/x', { signal: ctrl.signal })
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect(init.signal).toBe(ctrl.signal)
  })

  it('apiFetch propagates a timeout abort as transient failure (no session clear)', async () => {
    // 请求悬挂 15s 被 AbortSignal.timeout 中止后 fetch reject（TimeoutError）：
    // 按瞬态失败语义抛给上层——不清会话、不标 refreshExhausted（悬挂不再永久卡死）。
    const auth = useAuthStore()
    auth.token = 'tok'
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new DOMException('The operation timed out', 'TimeoutError'),
    )
    await expect(apiFetch('/api/v1/x')).rejects.toThrow('The operation timed out')
    expect(auth.token).toBe('tok')
    expect(auth.refreshExhausted).toBe(false)
  })

  it('apiJson throws ApiError with backend detail on non-2xx', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ detail: '非法 name' }, 400),
    )
    await expect(apiJson('/x')).rejects.toThrow('非法 name')
  })
})
