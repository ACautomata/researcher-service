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

  it('登录失败显示后端真实错误而非写死文案', async () => {
    // codex P2-8 + BUG 修复：登录失败须显示后端真实错误（api/errors.ts 透传），
    // 而非写死「登录失败」掩盖真实原因。
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ non_field_errors: ['用户名或密码错误'] }),
    } as unknown as Response)
    const w = mountLogin()
    await w.find('input[type="text"]').setValue('alice')
    await w.find('input[type="password"]').setValue('wrong-pass-1')
    await w.find('button').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('用户名或密码错误')
  })

  it('注册失败显示真实校验原因（弱密码不再误报「账号已被注册」）', async () => {
    // BUG 修复核心：旧实现任意注册失败都显示「用户名可能已存在」，
    // 实则多为弱密码被拒。现须透传 DRF 密码校验消息，且不得再出现误导文案。
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ password: ['这个密码太常见了。'] }),
    } as unknown as Response)
    const w = mountLogin()
    await w.find('[data-test="switch-register"]').trigger('click')
    await w.find('input[type="text"]').setValue('weakuser')
    await w.find('input[type="password"]').setValue('12345678')
    await w.find('button').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('这个密码太常见了。')
    expect(w.text()).not.toContain('已存在')
  })

  it('网络异常（fetch reject）显示本地化兜底而非浏览器原始报错文本', async () => {
    // codex P2：fetch 因后端不可达 reject 时浏览器抛 TypeError ("Failed to fetch"
    // / "Load failed")。仅「已解析的 API 错误」可逐字透传；网络/意外错误须走
    // 模式专属中文兜底,不应把英文浏览器消息直接展示给用户、也不能盖掉可重试提示。
    const w = mountLogin()
    // 切到注册模式,验证注册兜底
    await w.find('[data-test="switch-register"]').trigger('click')
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    await w.find('input[type="text"]').setValue('alice')
    await w.find('input[type="password"]').setValue('pw123456')
    await w.find('button').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('注册失败，请稍后重试')
    expect(w.text()).not.toContain('Failed to fetch')
    expect(w.text()).not.toContain('Load failed')
  })

  it('登录网络异常显示登录兜底而非浏览器原始报错文本', async () => {
    // codex P2 镜像用例：登录模式同根因,须显示「登录失败，请稍后重试」。
    const w = mountLogin()
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Load failed'))
    await w.find('input[type="text"]').setValue('alice')
    await w.find('input[type="password"]').setValue('pw123456')
    await w.find('button').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('登录失败，请稍后重试')
    expect(w.text()).not.toContain('Load failed')
  })

  it('registers a new account when switched to register mode (codex round-4 F5)', async () => {
    // spec §9.2：登录页须含本地账号注册表单。切到注册模式提交应调 /register。
    const w = mountLogin()
    await w.find('[data-test="switch-register"]').trigger('click')
    await w.find('input[type="text"]').setValue('newbie')
    await w.find('input[type="password"]').setValue('newpass-1')
    await w.find('button').trigger('click')
    await flushPromises()
    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0][0]).toBe('/api/v1/auth/register')
    expect(JSON.parse(calls[0][1].body)).toEqual({ username: 'newbie', password: 'newpass-1' })
  })
})
