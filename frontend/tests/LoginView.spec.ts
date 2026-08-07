// seam: 前端登录页组件 —— issue #37 P0 骨架 + #340-A 强制改密（C1 首登改密）。
// 出处 spec §9.2：本地账号登录表单 + 登录后存 access token。
// #340-A：公开注册已随后端 admin-only 关闭（#311），登录页无注册模式；me.mustChangePassword=true
// 的账号登录后进强制改密表单（旧+新+确认），改密成功撤销全部 refresh + 清 cookie 后须重登。
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

  it('#419-2: 输入框内回车（原生 form submit）即可提交登录', async () => {
    const w = mountLogin()
    await w.find('input[type="text"]').setValue('alice')
    await w.find('input[type="password"]').setValue('pw123456')
    await w.find('form').trigger('submit') // 回车提交 = form submit 事件
    await flushPromises()
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/auth/login',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(useAuthStore().isAuthenticated).toBe(true)
  })

  it('#419-2: 提交中按钮 loading/禁用，重复点击不重复提交', async () => {
    // 首次登录请求悬挂（pending）期间：按钮禁用（防重复点击），再触发点击不发起第二个请求
    let resolveLogin!: (v: unknown) => void
    global.fetch = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveLogin = resolve
      }),
    )
    const w = mountLogin()
    await w.find('input[type="text"]').setValue('alice')
    await w.find('input[type="password"]').setValue('pw123456')
    await w.find('button').trigger('click')
    await w.find('button').trigger('click') // 提交中重复点击
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    // 请求完成后按钮恢复可用
    resolveLogin({ ok: true, json: async () => ({ access: 'tk', refresh: 'rf' }) })
    await flushPromises()
    expect(w.find('button').attributes('disabled')).toBeUndefined()
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

  // #340-A 强制改密（C1 首登改密）：me.mustChangePassword=true → 登录后进改密表单，不跳容器页
  it('mustChangePassword=true 登录后进强制改密表单（不跳容器页）', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 0,
        message: 'ok',
        data: { access: 'tk', role: 'user', mustChangePassword: true, maxContainers: 5 },
      }),
    } as unknown as Response)
    const w = mountLogin()
    await w.find('input[type="text"]').setValue('alice')
    await w.find('input[type="password"]').setValue('init-pass-1')
    await w.find('button').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('修改密码')
    expect(w.text()).toContain('首次登录须先修改密码')
  })

  it('强制改密：两次新密码不一致 → 本地提示，不发改密请求', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 0,
        message: 'ok',
        data: { access: 'tk', role: 'user', mustChangePassword: true, maxContainers: 5 },
      }),
    } as unknown as Response)
    const w = mountLogin()
    await w.find('input[type="text"]').setValue('alice')
    await w.find('input[type="password"]').setValue('init-pass-1')
    await w.find('button').trigger('click')
    await flushPromises()
    const inputs = w.findAll('input[type="password"]')
    await inputs[0].setValue('init-pass-1')
    await inputs[1].setValue('new-pass-123')
    await inputs[2].setValue('new-pass-456') // 确认不一致
    await w.find('button').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('两次输入的新密码不一致')
    // 未调用改密端点
    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.some((c: unknown[]) => c[0] === '/api/v1/auth/password/change')).toBe(false)
  })

  it('强制改密成功：调 password/change（old+new）→ 清会话 → 以新密码重登 → 跳容器页', async () => {
    // 登录 → 改密 → 重登 三段 fetch
    const fetchMock = vi
      .fn()
      // 1) login（mustChangePassword=true → 进改密模式）
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          message: 'ok',
          data: { access: 'tk', role: 'user', mustChangePassword: true, maxContainers: 5 },
        }),
      } as unknown as Response)
      // 2) me（fetchMe 在 login 后）
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          message: 'ok',
          data: { role: 'user', mustChangePassword: true, maxContainers: 5 },
        }),
      } as unknown as Response)
      // 3) password/change 成功（data=null）
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, message: 'ok', data: null }),
      } as unknown as Response)
      // 4) 重登 login（mustChangePassword=false → 跳容器页）
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          message: 'ok',
          data: { access: 'tk2', role: 'user', mustChangePassword: false, maxContainers: 5 },
        }),
      } as unknown as Response)
      // 5) 重登后 fetchMe
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          message: 'ok',
          data: { role: 'user', mustChangePassword: false, maxContainers: 5 },
        }),
      } as unknown as Response)
    global.fetch = fetchMock
    const w = mountLogin()
    await w.find('input[type="text"]').setValue('alice')
    await w.find('input[type="password"]').setValue('init-pass-1')
    await w.find('button').trigger('click')
    await flushPromises()
    // 改密模式：3 个密码输入框（原/新/确认）
    const inputs = w.findAll('input[type="password"]')
    await inputs[0].setValue('init-pass-1')
    await inputs[1].setValue('new-pass-123')
    await inputs[2].setValue('new-pass-123')
    await w.find('button').trigger('click')
    await flushPromises()
    const calls = (fetchMock as ReturnType<typeof vi.fn>).mock.calls
    // 第 3 次调用 = password/change
    const changeCall = calls[2]
    expect(changeCall[0]).toBe('/api/v1/auth/password/change')
    expect(JSON.parse(changeCall[1].body)).toEqual({
      oldPassword: 'init-pass-1',
      newPassword: 'new-pass-123',
    })
    // 重登调用
    const relogin = calls[3]
    expect(relogin[0]).toBe('/api/v1/auth/login')
    expect(JSON.parse(relogin[1].body)).toEqual({ username: 'alice', password: 'new-pass-123' })
    // 改密后 mustChangePassword 清 + 会话重建
    expect(useAuthStore().token).toBe('tk2')
    expect(useAuthStore().mustChangePassword).toBe(false)
  })
})
