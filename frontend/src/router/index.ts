// 路由表 + 全局导航守卫（spec §9.1/§9.2：登录页骨架 + 未登录重定向）。
// #340-D：admin 账号管理页 `/admin/users`（#328）——首例 meta.requiresAdmin 守卫（admin-only
// nav 条件渲染 + 非 admin 重定向 `/`，消费 `me.role`）。
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import LoginView from '@/views/LoginView.vue'
import ContainersView from '@/views/ContainersView.vue'
import ChatView from '@/views/ChatView.vue'
import WikiView from '@/views/WikiView.vue'
import CategoriesView from '@/views/CategoriesView.vue'
import ModelView from '@/views/ModelView.vue'
import AdminUsersView from '@/views/AdminUsersView.vue'
import TraceLogsView from '@/views/TraceLogsView.vue'

export const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
  {
    path: '/',
    name: 'containers',
    component: ContainersView,
    meta: { requiresAuth: true },
  },
  {
    path: '/chat',
    name: 'chat',
    component: ChatView,
    meta: { requiresAuth: true },
  },
  {
    path: '/wiki',
    name: 'wiki',
    component: WikiView,
    meta: { requiresAuth: true },
  },
  {
    path: '/categories',
    name: 'categories',
    component: CategoriesView,
    meta: { requiresAuth: true },
  },
  {
    path: '/models',
    name: 'models',
    component: ModelView,
    meta: { requiresAuth: true },
  },
  // #328：顶层路由（无 /admin 嵌套壳）；meta.requiresAdmin 首例——非 admin 重定向 /
  {
    path: '/admin/users',
    name: 'admin-users',
    component: AdminUsersView,
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    path: '/admin/trace-logs',
    name: 'admin-trace-logs',
    component: TraceLogsView,
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { requiresAuth: true },
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

// 守卫：进入受保护路由前用 httpOnly refresh cookie 恢复登录态（codex P2-2），再判重定向。
// decideGuard 抽纯函数（可单测）：未认证时分「确认失效（refreshExhausted）→ 踢登录」与「瞬态」放行。
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (to.meta.requiresAuth) {
    await auth.hydrate()
  }
  return decideGuard(!!to.meta?.requiresAuth, auth, !!to.meta?.requiresAdmin)
})

// 守卫决策（纯函数）：受保护路由 + 未认证时，仅 refreshExhausted（refresh 端点确认 cookie 失效）
// 才跳登录；瞬态（token 空 + !refreshExhausted，如 forceRefresh 遇网络瞬态失败、cookie 仍可能有效）
// 放行——让首个 API 请求的 401 刷新链兜底重试，而非把 cookie 仍有效的用户冤枉踢下线（PR #370
// 第四轮 #10 P2）。requiresAdmin 路由（#340-D）：已认证但非 admin → 重定向 `/`（me.role 判别；
// 角色误判/未拉到 me 时交 API 10004 兜底）。非受保护路由 / 已认证 → 放行。
export function decideGuard(
  requiresAuth: boolean,
  auth: { isAuthenticated: boolean; refreshExhausted: boolean; role: string },
  requiresAdmin = false,
): { name: 'login' } | { name: 'containers' } | undefined {
  if (!requiresAuth) return undefined
  if (auth.isAuthenticated) {
    if (requiresAdmin && auth.role !== 'admin') return { name: 'containers' }
    return undefined
  }
  if (auth.refreshExhausted) return { name: 'login' }
  return undefined // 瞬态：放行，交 apiFetch 401 刷新链
}

export default router
