// seam: 前端路由表 + 导航守卫 —— issue #37 P0 骨架。
// 出处 spec §1/§9.2：登录页骨架 + 全局 token 拦截（前端镜像后端 JWT 拦截）。
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import router from '@/router'
import { useAuthStore } from '@/stores/auth'

// 合法且未过期的 JWT（exp 远在未来）：isTokenExpired 判 false → hydrate early-return。
// 用于模拟"持有有效会话"，避免非法 token 占位被当成过期触发 refresh。
function unexpiredJwt(): string {
  return `header.${btoa(JSON.stringify({ exp: 9999999999 }))}.sig`
}

describe('router guard', () => {
  beforeEach(async () => {
    // 每个用例独立的 Pinia（token 默认空 = 未认证）
    setActivePinia(createPinia())
    // 守卫 hydrate 会调 fetch；默认 mock 为 refresh 400（cookie 无效 = 确认未认证）→
    // refreshExhausted=true（#10：守卫区分「确认失效踢 login」与「瞬态放行」，默认走前者）。
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
    } as unknown as Response)
    // 重置到 login 起点，避免上一用例残留 '/' 导致同路由 no-op 跳过守卫
    await router.push({ name: 'login' })
  })

  it('exposes a named login route', () => {
    expect(router.hasRoute('login')).toBe(true)
  })

  it('redirects unauthenticated visits to /login', async () => {
    await router.push('/')
    expect(router.currentRoute.value.name).toBe('login')
  })

  it('allows authenticated visits to the protected route', async () => {
    const auth = useAuthStore()
    auth.token = unexpiredJwt() // 模拟已登录（token 来源不属守卫职责）
    await router.push('/')
    expect(router.currentRoute.value.name).toBe('containers')
  })

  it('redirects authenticated visits to /login back to the home page (#419-1)', async () => {
    // 已登录用户不应停留在登录页（守卫缺 public 分支时 /login 对已登录用户不跳走）。
    // 先进入受保护路由（守卫放行），再从 containers 访问 /login → 应被弹回首页。
    const auth = useAuthStore()
    auth.token = unexpiredJwt()
    await router.push('/')
    expect(router.currentRoute.value.name).toBe('containers')
    await router.push('/login')
    expect(router.currentRoute.value.name).toBe('containers')
  })

  it('hydrates token from refresh cookie on first navigation', async () => {
    // codex P2-2：刷新页面后用 httpOnly refresh cookie 换 access 恢复登录态
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access: 'hydrated-token' }),
    } as unknown as Response)
    const auth = useAuthStore()
    await router.push('/')
    await flushPromises()
    expect(auth.token).toBe('hydrated-token')
  })

  it('refreshes an expired access token via cookie on navigation', async () => {
    // codex P2-1：内存 access 过期后，hydrate 应再用 cookie 换新而非 early-return
    const expired = btoa(JSON.stringify({ exp: 1 })) // 1970，必过期
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access: 'fresh-token' }),
    } as unknown as Response)
    const auth = useAuthStore()
    auth.token = `header.${expired}.sig`
    await router.push('/')
    await flushPromises()
    expect(auth.token).toBe('fresh-token')
  })

  it('clears a stale expired token when refresh fails so the guard does not admit it (codex round-4 F1)', async () => {
    // 过期 token + refresh 400（cookie 缺失/无效）：不应让过期 token 进入受保护路由。
    // 修复前 hydrate 只在 401/403 清 token，400 路径漏过 → isAuthenticated 仍真 → 放行过期凭证。
    const expired = btoa(JSON.stringify({ exp: 1 }))
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
    } as unknown as Response)
    const auth = useAuthStore()
    auth.token = `header.${expired}.sig`
    await router.push('/')
    await flushPromises()
    expect(auth.token).toBe('')
    expect(auth.refreshExhausted).toBe(true)
    expect(router.currentRoute.value.name).toBe('login')
  })

  it('logout calls backend to clear cookie and resets local state', async () => {
    // codex P2-2：有效会话 logout 直接调后端清 httpOnly cookie + 重置本地（不触发 refresh）
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as unknown as Response)
    global.fetch = fetchMock
    const auth = useAuthStore()
    auth.token = unexpiredJwt()
    await auth.logout()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(auth.token).toBe('')
    expect(auth.refreshExhausted).toBe(true)
  })

  it('logout refreshes an expired access token before clearing the cookie (codex round-4 F2)', async () => {
    // access 过期：logout 前先用 cookie 换新，否则后端 IsAuthenticated 401 清不掉 cookie → 重载又登回来
    const expired = btoa(JSON.stringify({ exp: 1 }))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access: 'fresh' }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as unknown as Response) // fetchMe（#340-D，无 role 静默）
      .mockResolvedValueOnce({ ok: true } as unknown as Response)
    global.fetch = fetchMock
    const auth = useAuthStore()
    auth.token = `header.${expired}.sig`
    await auth.logout()
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/v1/auth/logout',
      expect.objectContaining({ headers: { Authorization: 'Bearer fresh' } }),
    )
    expect(auth.token).toBe('')
  })
})
