// seam: 路由守卫决策——未认证分「确认失效踢登录」与「瞬态放行」（spec §9.1/§9.2 + #10）。
// #800：admin 路由（admin-users/admin-trace-logs/admin-docs 等）整体迁入 /admin/ 子应用
// （@/admin/router + decideAdminGuard 测试）——主面板路由表零 admin 残留、decideGuard 不判角色。
import { describe, expect, it } from 'vitest'
import router, { decideGuard, routes } from '@/router/index'

const authed = { isAuthenticated: true, refreshExhausted: false, role: 'user' }
const authedAdmin = { isAuthenticated: true, refreshExhausted: false, role: 'admin' }
const transient = { isAuthenticated: false, refreshExhausted: false, role: '' }
const exhausted = { isAuthenticated: false, refreshExhausted: true, role: '' }

describe('页面路由按需加载', () => {
  it('所有页面组件均使用动态导入', () => {
    const records = router.getRoutes().filter((route) => route.name)
    expect(records.map((route) => String(route.name)).sort()).toEqual([
      'categories',
      'chat',
      'figure-editor',
      'legal-document',
      'login',
      'models',
      'not-found',
      'plugins',
      'wiki',
    ])
    expect(records.every((route) => typeof route.components?.default === 'function')).toBe(true)
  })

  it('主面板路由表无 /admin/* 残留（#800 迁入 admin 子应用）', () => {
    expect(recordsWithAdminPrefix()).toEqual([])
  })
})

function recordsWithAdminPrefix(): string[] {
  return router
    .getRoutes()
    .filter((route) => String(route.path).startsWith('/admin'))
    .map((route) => String(route.name ?? route.path))
}

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

  // #800：requiresAdmin 语义迁入 admin 子应用守卫（decideAdminGuard）——主面板 decideGuard
  // 不再判角色（参数已移除）。
  it('普通路由不受角色影响', () => {
    expect(decideGuard(true, authed)).toBeUndefined()
    expect(decideGuard(true, authedAdmin)).toBeUndefined()
  })
})

describe('Figure Editor 路由', () => {
  it('注册为受保护路由且懒加载 FigureEditorView', () => {
    const record = routes.find((route) => route.name === 'figure-editor')
    expect(record).toMatchObject({
      path: '/figure-editor',
      name: 'figure-editor',
      meta: { requiresAuth: true },
    })
    expect(record?.component).toBeTypeOf('function')
    expect(router.resolve('/figure-editor').name).toBe('figure-editor')
  })
})

describe('route fallback', () => {
  it('maps unknown paths to an authenticated not-found page', () => {
    const fallback = routes.find((route) => route.name === 'not-found')
    expect(fallback).toMatchObject({
      path: '/:pathMatch(.*)*',
      meta: { requiresAuth: true },
    })
    expect(fallback?.component).toBeTypeOf('function')
    expect(router.resolve('/definitely-missing').name).toBe('not-found')
  })
})
