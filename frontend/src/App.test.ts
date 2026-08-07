import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import App from '@/App.vue'

const { auth, replace } = vi.hoisted(() => ({
  auth: {
    role: '',
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
})
