// seam: auth store clearSession —— codex R1 :102。
// 覆盖：401 清会话时只清 access token，不标 refreshExhausted——让 hydrate 用 refresh
// 端点真实结果决定耗尽（access 过期但 httpOnly refresh cookie 仍有效时不被迫重登）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useAuthStore } from '@/stores/auth'

// 复刻 api/client.test.ts 的 Response mock 形态。
function mockResp(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response
}

describe('auth.clearSession', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('clears access token on 401', () => {
    const auth = useAuthStore()
    auth.token = 'expired-access'
    auth.clearSession()
    expect(auth.token).toBe('')
  })

  it('does not exhaust refresh cookie on 401 (codex R1 :102)', () => {
    // access 可能仅过期，httpOnly refresh cookie 仍有效——交由 hydrate 试 refresh 决定
    const auth = useAuthStore()
    auth.token = 'expired-access'
    auth.refreshExhausted = false
    auth.clearSession()
    expect(auth.refreshExhausted).toBe(false)
  })
})

// 修复 BUG：注册无论输入什么都显示「账号已被注册」。
// 根因：auth.register/login 旧实现只抛写死文案，丢弃 DRF 错误体（多为弱密码被拒）；
// 现须透传后端真实校验消息。
describe('auth register/login 错误透传', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('register 透传密码校验消息而非写死「注册失败」', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ password: ['这个密码太常见了。'] }, 400),
    )
    await expect(useAuthStore().register('weakuser', '12345678')).rejects.toThrow(
      '这个密码太常见了。',
    )
  })

  it('register 透传重复用户名错误', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ username: ['该字段必须唯一。'] }, 400),
    )
    await expect(useAuthStore().register('dup', 'strong-pass-1')).rejects.toThrow(
      '该字段必须唯一。',
    )
  })

  it('login 透传 non_field_errors', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ non_field_errors: ['用户名或密码错误'] }, 400),
    )
    await expect(useAuthStore().login('x', 'y')).rejects.toThrow('用户名或密码错误')
  })

  it('5xx 非 JSON 响应用状态码兜底', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 500,
      ok: false,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
    } as unknown as Response)
    await expect(useAuthStore().register('u', 'p')).rejects.toThrow('请求失败（500）')
  })

  it('register 成功后自动登录建立会话（happy path 未破坏）', async () => {
    const auth = useAuthStore()
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(mockResp({ id: 1, username: 'ok' }, 201)) // register 201
      .mockResolvedValueOnce(mockResp({ access: 'tok-ok' }, 200)) // login 200
    await auth.register('okuser', 'strong-pass-123')
    expect(auth.token).toBe('tok-ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
