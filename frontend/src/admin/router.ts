// admin 子应用路由表 + 守卫（#800 双面板 MPA）。
// base = /admin/（nginx 按 /admin/ 分流到 admin.html）；全部路由 requiresAuth+requiresAdmin——
// 守卫收敛为单一决策点 decideAdminGuard（纯函数，镜像主面板 decideGuard 的「瞬态放行交
// 401 刷新链」语义；跨应用落点 login/home 由守卫侧 window.location.assign 执行）。
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

export const adminRoutes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'admin-users',
    component: () => import('@/admin/views/AdminUsersView.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    path: '/audit',
    name: 'admin-audit',
    component: () => import('@/admin/views/AuditLogsView.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    path: '/usage',
    name: 'admin-usage',
    component: () => import('@/admin/views/UsageView.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    path: '/trace-logs',
    name: 'admin-trace-logs',
    component: () => import('@/admin/views/TraceLogsView.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    path: '/docs',
    name: 'admin-docs',
    component: () => import('@/admin/views/ApiDocsView.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    path: '/:pathMatch(.*)*',
    // admin 内未知路径 → 回运营首页（admin 子应用无独立 404 页，用户面板 NotFoundView 不同步迁入）
    redirect: '/',
  },
]

const router = createRouter({
  history: createWebHistory('/admin/'),
  routes: adminRoutes,
})

// 守卫决策（纯函数，可单测）：admin 子应用全路由受保护——
// 未认证：refreshExhausted（用户面板 refresh 端点确认 cookie 失效）→ 'login'（跨应用跳
//   /login，守卫侧执行 location.assign）；瞬态 → 'allow'（放行，首个 admin API 的 401
//   刷新链兜底重试——踢人决定权在 refresh 端点真实结果，镜像主面板 decideGuard）。
// 已认证：role==='admin' → 'allow'；否则 'home'（me 静默降级/角色误判 → 回用户面板 /，
//   数据面仍由后端 admin 门 10004 兜底）。
export function decideAdminGuard(auth: {
  isAuthenticated: boolean
  refreshExhausted: boolean
  role?: string
}): 'allow' | 'login' | 'home' {
  if (!auth.isAuthenticated) {
    return auth.refreshExhausted ? 'login' : 'allow'
  }
  return auth.role === 'admin' ? 'allow' : 'home'
}

router.beforeEach(async () => {
  const auth = useAuthStore()
  await auth.hydrate()
  const decision = decideAdminGuard(auth)
  if (decision === 'allow') return true
  if (typeof window !== 'undefined') {
    window.location.assign(decision === 'login' ? '/login' : '/')
  }
  return false
})

export default router
