// seam: admin 子应用路由守卫（#800 双面板 MPA）。
// decideAdminGuard 纯函数（可单测）：admin 子应用全路由 requiresAuth+requiresAdmin——
// 未认证且 refresh 确认失效 → 跳用户面板登录页（跨应用，守卫侧 window.location.assign）；
// 未认证瞬态 → 放行（交 apiFetch 401 刷新链兜底，镜像主面板 decideGuard 语义）；
// 已认证非 admin → 回用户面板 /（后端 admin 门 10004 兜底数据面）。
import { describe, it, expect } from 'vitest'
import { decideAdminGuard } from '@/admin/router'

describe('decideAdminGuard（#800 admin 子应用守卫纯函数）', () => {
  it('未认证 + refresh 确认失效 → login（跨应用跳用户面板 /login）', () => {
    expect(decideAdminGuard({ isAuthenticated: false, refreshExhausted: true })).toBe('login')
  })

  it('未认证 + 瞬态（cookie 仍可能有效）→ allow（放行交 apiFetch 401 刷新链）', () => {
    expect(decideAdminGuard({ isAuthenticated: false, refreshExhausted: false })).toBe('allow')
  })

  it('已认证 + admin → allow', () => {
    expect(decideAdminGuard({ isAuthenticated: true, refreshExhausted: false, role: 'admin' })).toBe('allow')
  })

  it('已认证 + 非 admin → home（回用户面板；数据面由后端 10004 兜底）', () => {
    expect(decideAdminGuard({ isAuthenticated: true, refreshExhausted: false, role: 'user' })).toBe('home')
  })

  it('已认证 + role 未拉到（me 静默降级空串）→ home', () => {
    expect(decideAdminGuard({ isAuthenticated: true, refreshExhausted: false, role: '' })).toBe('home')
  })
})
