// seam: 路由守卫决策——未认证分「确认失效踢登录」与「瞬态放行」（spec §9.1/§9.2 + #10）。
import { describe, expect, it } from 'vitest'
import { decideGuard } from '@/router/index'

const authed = { isAuthenticated: true, refreshExhausted: false }
const transient = { isAuthenticated: false, refreshExhausted: false }
const exhausted = { isAuthenticated: false, refreshExhausted: true }

describe('decideGuard（守卫决策纯函数）', () => {
  it('受保护路由 + 已认证 → 放行', () => {
    expect(decideGuard(true, authed)).toBeUndefined()
  })

  it('受保护路由 + 确认失效（refreshExhausted）→ 跳登录', () => {
    expect(decideGuard(true, exhausted)).toEqual({ name: 'login' })
  })

  // PR #370 第四轮 #10（P2）：forceRefresh 瞬态网络失败后 token 空，但 httpOnly refresh cookie
  // 仍可能有效——守卫不得直接跳 /login 踢人。放行让首个 API 请求的 401 刷新链兜底重试。
  it('受保护路由 + 瞬态（token 空但 !refreshExhausted）→ 放行，交 401 刷新链兜底', () => {
    expect(decideGuard(true, transient)).toBeUndefined()
  })

  it('公开路由 → 一律放行', () => {
    expect(decideGuard(false, transient)).toBeUndefined()
    expect(decideGuard(false, exhausted)).toBeUndefined()
  })
})
