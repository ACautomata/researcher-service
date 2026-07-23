// seam: 前端路由表 + 导航守卫 —— issue #37 P0 骨架。
// 出处 spec §1/§9.2：登录页骨架 + 全局 token 拦截（前端镜像后端 JWT 拦截）。
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import router from '@/router'
import { useAuthStore } from '@/stores/auth'

describe('router guard', () => {
  beforeEach(() => {
    // 每个用例独立的 Pinia（token 默认空 = 未认证）
    setActivePinia(createPinia())
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
})
