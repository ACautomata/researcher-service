// seam: auth store clearSession —— codex R1 :102。
// 覆盖：401 清会话时只清 access token，不标 refreshExhausted——让 hydrate 用 refresh
// 端点真实结果决定耗尽（access 过期但 httpOnly refresh cookie 仍有效时不被迫重登）。
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useAuthStore } from '@/stores/auth'

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
