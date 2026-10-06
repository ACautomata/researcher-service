import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import App from '@/App.vue'

const { auth, replace } = vi.hoisted(() => ({
  auth: {
    role: '',
    isAuthenticated: false,
    logout: vi.fn(),
  },
  replace: vi.fn(),
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => auth,
}))

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ replace }),
}))

describe('App navigation', () => {
  beforeEach(() => {
    auth.role = ''
    auth.isAuthenticated = false
    auth.logout.mockReset()
    replace.mockReset()
  })

  it('主动退出后跳转登录页', async () => {
    auth.logout.mockResolvedValue(undefined)
    replace.mockResolvedValue(undefined)
    const wrapper = mount(App, {
      global: {
        mocks: { $route: { name: 'chat' } },
        stubs: { RouterLink: true, RouterView: true },
      },
    })

    await wrapper.get('[data-test="nav-logout"]').trigger('click')
    await flushPromises()

    expect(auth.logout).toHaveBeenCalledOnce()
    expect(replace).toHaveBeenCalledWith('/login')
    expect(auth.logout.mock.invocationCallOrder[0]).toBeLessThan(replace.mock.invocationCallOrder[0])
  })

  // F1（docs/figure-editor/reconnaissance.md）：Figure Editor 入口为常规受保护页——登录 shell 下
  // 恒显示，不随 AutoFigure capability / admin role 条件渲染（非 admin-only、非 flag-gated）。
  it('Figure Editor nav 入口：登录 shell 下显示', () => {
    auth.isAuthenticated = true
    const wrapper = mount(App, {
      global: {
        mocks: { $route: { name: 'chat' } },
        stubs: { RouterLink: true, RouterView: true },
      },
    })
    expect(wrapper.find('[data-test="nav-figure-editor"]').exists()).toBe(true)
  })

})
