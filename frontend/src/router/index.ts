// 路由表 + 全局导航守卫（spec §9.1/§9.2：登录页骨架 + 未登录重定向）。
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import LoginView from '@/views/LoginView.vue'
import ContainersView from '@/views/ContainersView.vue'
import ChatView from '@/views/ChatView.vue'
import WikiView from '@/views/WikiView.vue'
import CategoriesView from '@/views/CategoriesView.vue'
import ModelView from '@/views/ModelView.vue'

const routes: RouteRecordRaw[] = [
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
  return decideGuard(!!to.meta?.requiresAuth, auth)
})

// 守卫决策（纯函数）：受保护路由 + 未认证时，仅 refreshExhausted（refresh 端点确认 cookie 失效）
// 才跳登录；瞬态（token 空 + !refreshExhausted，如 forceRefresh 遇网络瞬态失败、cookie 仍可能有效）
// 放行——让首个 API 请求的 401 刷新链兜底重试，而非把 cookie 仍有效的用户冤枉踢下线（PR #370
// 第四轮 #10 P2）。非受保护路由 / 已认证 → 放行。
export function decideGuard(
  requiresAuth: boolean,
  auth: { isAuthenticated: boolean; refreshExhausted: boolean },
): { name: 'login' } | undefined {
  if (!requiresAuth) return undefined
  if (auth.isAuthenticated) return undefined
  if (auth.refreshExhausted) return { name: 'login' }
  return undefined // 瞬态：放行，交 apiFetch 401 刷新链
}

export default router
