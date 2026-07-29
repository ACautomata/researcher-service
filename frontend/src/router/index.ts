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
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (to.meta.requiresAuth) {
    await auth.hydrate()
  }
  if (to.meta.requiresAuth && !auth.isAuthenticated) {
    return { name: 'login' }
  }
  // #202 问题6：已登录访问 /login 等 public 页 → 回首页，不重复展示登录表单
  if (to.meta.public && auth.isAuthenticated) {
    return { name: 'containers' }
  }
})

export default router
