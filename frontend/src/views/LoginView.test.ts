// seam: LoginView 角色落点（#800）——登录成功按 me.role 分流：admin → /admin/ 运营子应用
// （跨 MPA 整页跳转 window.location.assign）；user → 本面板 /（router.push）。
// mustChangePassword 优先于角色落点（强制改密流程不跳走）。
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/auth', () => ({
  changePassword: vi.fn(),
}))
vi.mock('@/stores/auth', () => ({
  useAuthStore: vi.fn(),
}))

import LoginView from '@/views/LoginView.vue'
import { useAuthStore } from '@/stores/auth'

const stubs = {
  ElForm: { template: '<form @submit.prevent><slot /></form>' },
  ElFormItem: { template: '<div><slot /></div>', props: ['label'] },
  ElInput: {
    props: ['modelValue', 'type', 'placeholder'],
    emits: ['update:modelValue'],
    template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  ElButton: {
    props: ['type', 'loading', 'disabled'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  RouterLink: { template: '<a><slot /></a>', props: ['to'] },
}

function mockAuth(overrides: Record<string, unknown>) {
  const auth = {
    token: 'jwt',
    isAuthenticated: true,
    refreshExhausted: false,
    role: 'user',
    mustChangePassword: false,
    login: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
  ;(useAuthStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue(auth)
  return auth
}

describe('LoginView 角色落点（#800）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.stubGlobal('location', { ...window.location, assign: vi.fn(), pathname: '/login' })
  })

  it('admin 登录成功 → window.location.assign("/admin/")（跨 MPA，不 router.push）', async () => {
    const auth = mockAuth({ role: 'admin' })
    const wrapper = mount(LoginView, { global: { stubs } })
    const vm = wrapper.vm as unknown as { onSubmit: () => Promise<void>; form: { username: string; password: string } }
    vm.form.username = 'root'
    vm.form.password = 'pw-root-secure-1'
    await vm.onSubmit()
    await flushPromises()
    expect(auth.login).toHaveBeenCalledWith('root', 'pw-root-secure-1')
    expect(window.location.assign).toHaveBeenCalledWith('/admin/')
  })

  it('user 登录成功 → 本面板路由跳转（不跨应用）', async () => {
    mockAuth({ role: 'user' })
    const push = vi.fn()
    const wrapper = mount(LoginView, {
      global: {
        stubs,
        mocks: { $router: { push } },
        // useRouter() 在组件 setup 取注入——经 mock router 注入
        provide: { router: { push } },
      },
    })
    ;(wrapper.vm as unknown as { onSubmit: () => Promise<void> }).onSubmit()
    await flushPromises()
    expect(window.location.assign).not.toHaveBeenCalled()
  })

  it('mustChangePassword=true 优先于角色落点 → 进入改密模式，不跳 /admin/', async () => {
    mockAuth({ role: 'admin', mustChangePassword: true })
    const wrapper = mount(LoginView, { global: { stubs } })
    ;(wrapper.vm as unknown as { onSubmit: () => Promise<void> }).onSubmit()
    await flushPromises()
    expect(window.location.assign).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('修改密码')
  })
})
