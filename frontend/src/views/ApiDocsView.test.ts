// seam: ApiDocsView —— API 文档面（#761，admin-only）。
// 覆盖：spec 经 apiJson 拉取并注入 SwaggerUIBundle · TryIt requestInterceptor 注入 Bearer token ·
// 加载失败呈现错误 alert · unmount 销毁 UI 实例。
// swagger-ui-dist 的 UMD bundle 整体 mock（jsdom 下加载真实 bundle 无意义且慢）。
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const { swaggerUI } = vi.hoisted(() => ({
  swaggerUI: vi.fn((..._args: unknown[]) => ({ destroy: vi.fn() })),
}))
vi.mock('swagger-ui-dist/swagger-ui-bundle.js', () => ({
  default: (...args: unknown[]) => swaggerUI(...args),
}))

vi.mock('@/api/client', () => ({
  apiJson: vi.fn(),
}))

import ApiDocsView from '@/views/ApiDocsView.vue'
import { apiJson } from '@/api/client'
import { useAuthStore } from '@/stores/auth'

const SPEC = { openapi: '3.1.0', info: { title: 't', version: '1.0.0' }, paths: {} }

// Element Plus 未全局注册（对齐 AdminUsersView 测试模式）：ElAlert stub，attrs（data-test）经
// fallthrough 落到 stub 根元素，title 渲染为文本供断言。
function mountView() {
  return mount(ApiDocsView, {
    global: {
      stubs: { ElAlert: { props: ['type', 'title'], template: '<div class="el-alert-stub">{{ title }}</div>' } },
    },
  })
}

describe('ApiDocsView（#761）', () => {
  let auth: ReturnType<typeof useAuthStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    auth = useAuthStore()
    auth.token = 'access-token-1'
    vi.mocked(apiJson).mockResolvedValue(SPEC)
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('挂载后拉 openapi.json 并以注入 spec 初始化 SwaggerUI', async () => {
    mountView()
    await flushPromises()
    expect(apiJson).toHaveBeenCalledWith('/api/docs/openapi.json')
    expect(swaggerUI).toHaveBeenCalledTimes(1)
    const opts = swaggerUI.mock.calls[0][0] as Record<string, unknown>
    expect(opts.spec).toBe(SPEC)
    expect(opts.domNode).toBeInstanceOf(HTMLElement)
    expect(opts.docExpansion).toBe('none')
  })

  it('requestInterceptor 给 TryIt 请求注入 Bearer token', async () => {
    mountView()
    await flushPromises()
    const opts = swaggerUI.mock.calls[0][0] as Record<string, unknown>
    const interceptor = opts.requestInterceptor as (req: { headers: Record<string, string> }) => unknown
    const req = { headers: {} as Record<string, string> }
    const out = interceptor(req)
    expect((out as typeof req).headers.Authorization).toBe('Bearer access-token-1')
  })

  it('token 更新到拦截时取（非挂载时快照）', async () => {
    mountView()
    await flushPromises()
    auth.token = 'rotated-token-2'
    const opts = swaggerUI.mock.calls[0][0] as Record<string, unknown>
    const interceptor = opts.requestInterceptor as (req: { headers: Record<string, string> }) => unknown
    const req = { headers: {} as Record<string, string> }
    interceptor(req)
    expect(req.headers.Authorization).toBe('Bearer rotated-token-2')
  })

  it('拉取失败 → 错误 alert，不初始化 SwaggerUI', async () => {
    vi.mocked(apiJson).mockRejectedValue(new Error('network down'))
    const wrapper = mountView()
    await flushPromises()
    expect(swaggerUI).not.toHaveBeenCalled()
    expect(wrapper.get('[data-test="docs-error"]').text()).toContain('network down')
  })

  it('unmount 销毁 UI 实例', async () => {
    const wrapper = mountView()
    await flushPromises()
    const destroy = (swaggerUI.mock.results[0].value as { destroy: () => void }).destroy
    wrapper.unmount()
    expect(destroy).toHaveBeenCalled()
  })
})
