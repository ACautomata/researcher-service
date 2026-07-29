// seam: 路由守卫 —— issue #202 问题6：已登录访问 /login 等 public 页重定向回首页。
// 用真实 router（createWebHistory 在 jsdom 可用），不挂载组件，仅断言导航结果。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import router from '@/router/index'
import { useAuthStore } from '@/stores/auth'

// 未过期 JWT（exp 远大于现在）：hydrate 判 token 有效跳过 fetch
function liveToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))
    .replace(/=+$/, '')
  return `h.${payload}.s`
}

function mockResp(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response
}

describe('router guard — issue #202 问题6', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('已登录访问 /login 重定向到 containers', async () => {
    useAuthStore().token = liveToken()
    await router.push('/login')
    expect(router.currentRoute.value.name).toBe('containers')
  })

  it('未登录访问受保护页仍重定向到 /login（既有行为回归）', async () => {
    // hydrate 试 refresh：cookie 无效（401）→ 保持未登录
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp('', 401)))
    await router.push('/models')
    expect(router.currentRoute.value.name).toBe('login')
  })

  it('未登录访问 /login 正常停留（不误重定向）', async () => {
    await router.push('/login')
    expect(router.currentRoute.value.name).toBe('login')
  })
})
