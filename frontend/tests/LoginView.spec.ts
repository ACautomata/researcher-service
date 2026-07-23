// seam: 前端登录页组件 —— issue #37 P0 骨架。
// 出处 spec §9.2：本地账号登录表单 + 登录后存 access token。
import { createMemoryHistory, createRouter } from 'vue-router'
import { mount, flushPromises } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LoginView from '@/views/LoginView.vue'
import { useAuthStore } from '@/stores/auth'

function mountLogin() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', name: 'login', component: { template: '<div/>' } },
      { path: '/', name: 'containers', component: { template: '<div/>' } },
    ],
  })
  return mount(LoginView, { global: { plugins: [pinia, router, ElementPlus] } })
}

describe('LoginView', () => {
  beforeEach(() => {
    // 期望 token 'tk' 来自 mock 返回，非用代码同样方式重算
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access: 'tk', refresh: 'rf' }),
    } as unknown as Response)
  })

  it('renders username input, password input, and a submit button', () => {
    const w = mountLogin()
    expect(w.find('input[type="text"]').exists()).toBe(true)
    expect(w.find('input[type="password"]').exists()).toBe(true)
    expect(w.find('button').text()).toContain('登录')
  })

  it('submits credentials and stores the access token', async () => {
    const w = mountLogin()
    await w.find('input[type="text"]').setValue('alice')
    await w.find('input[type="password"]').setValue('pw123456')
    await w.find('button').trigger('click')
    await flushPromises()
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/auth/login',
      expect.objectContaining({ method: 'POST' }),
    )
    const body = JSON.parse((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body).toEqual({ username: 'alice', password: 'pw123456' })
    expect(useAuthStore().isAuthenticated).toBe(true)
  })

  it('shows an error message when login fails', async () => {
    // codex P2-8：登录失败应显示错误，而非 unhandled rejection
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    } as unknown as Response)
    const w = mountLogin()
    await w.find('input[type="text"]').setValue('alice')
    await w.find('input[type="password"]').setValue('wrong-pass-1')
    await w.find('button').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('登录失败')
  })
})
