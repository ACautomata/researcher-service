// 路由表 + 全局导航守卫（spec §9.1/§9.2：登录页骨架 + 未登录重定向）。
// #800：admin 运营面整体迁入 /admin/ 子应用（@/admin/router，decideAdminGuard 守卫）——
// 主面板路由零 admin 残留，本文件守卫不再判角色（requiresAdmin 语义随迁移移除）。
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

export const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { public: true } },
  {
    path: '/legal/:type(terms|privacy)',
    name: 'legal-document',
    component: () => import('@/views/LegalDocumentView.vue'),
    meta: { public: true },
  },
  {
    // #858 容器管理页退役：产品只呈现会话 / wiki / 模型配置——首页 `/` 重定向到对话。
    path: '/',
    redirect: '/chat',
  },
  {
    path: '/chat',
    name: 'chat',
    component: () => import('@/views/ChatView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/wiki',
    name: 'wiki',
    component: () => import('@/views/WikiView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/models',
    name: 'models',
    component: () => import('@/views/ModelView.vue'),
    meta: { requiresAuth: true },
  },
  {
    // 插件目录页（#799 · #752 §4）：能力可见性唯一入口 + per-user 启用位管理。
    path: '/plugins',
    name: 'plugins',
    component: () => import('@/views/PluginsView.vue'),
    meta: { requiresAuth: true },
  },
  // #800：admin 运营面（账号管理/白名单/审计/Usage/内容消息/API 文档）整体迁入 admin 子应用
  // （/admin/ MPA 入口：生产 nginx try_files → admin.html；dev/preview 由 vite 插件 rewrite）。
  // 主路由零 /admin/* 残留——用户 bundle 产物级不含 admin 代码。
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
// #419-1：已登录访问 public 路由（/login）→ 重定向首页，避免登录页对已登录用户重复可见。
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (to.meta.requiresAuth) {
    await auth.hydrate()
  }
  if (to.name === 'login' && auth.isAuthenticated) {
    return { path: '/chat' }
  }
  return decideGuard(!!to.meta?.requiresAuth, auth)
})

// 守卫决策（纯函数）：受保护路由 + 未认证时，仅 refreshExhausted（refresh 端点确认 cookie 失效）
// 才跳登录；瞬态（token 空 + !refreshExhausted，如 forceRefresh 遇网络瞬态失败、cookie 仍可能有效）
// 放行——让首个 API 请求的 401 刷新链兜底重试，而非把 cookie 仍有效的用户冤枉踢下线（PR #370
// 第四轮 #10 P2）。非受保护路由 / 已认证 → 放行。
// #800：requiresAdmin 语义随 admin 路由整体迁入 /admin/ 子应用（decideAdminGuard），主面板
// 守卫不再判角色。
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
