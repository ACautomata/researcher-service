// seam: 前端路由表 + 导航守卫 —— issue #37 P0 骨架。
// 出处 spec §1/§9.2：登录页骨架 + 全局 token 拦截（前端镜像后端 JWT 拦截）。
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import router from '@/router'
import { useAuthStore } from '@/stores/auth'

describe('router guard', () => {
  beforeEach(async () => {
    // 每个用例独立的 Pinia（token 默认空 = 未认证）
    setActivePinia(createPinia())
    // 守卫 hydrate 会调 fetch；默认 mock 失败，token 保持空
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
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
    auth.token = 'fake-token' // 模拟已登录（token 来源不属守卫职责）
    await router.push('/')
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

  it('logout calls backend to clear cookie and resets local state', async () => {
    // codex P2-2：logout 调后端清 httpOnly cookie + 重置本地
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as unknown as Response)
    global.fetch = fetchMock
    const auth = useAuthStore()
    auth.token = 'some-token'
    await auth.logout()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(auth.token).toBe('')
    expect(auth.refreshExhausted).toBe(true)
  })
})
