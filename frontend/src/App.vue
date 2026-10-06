<script setup lang="ts">
// #800：用户面板壳——admin 入口收敛为单一「运营面板」链接（跨应用 <a href="/admin/">，
// 守卫在 admin 子应用 decideAdminGuard）；isAdmin 仅控制入口显隐，不判数据面（后端 10004 兜底）。
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { PRODUCT_NAME } from '@/product'

const auth = useAuthStore()
const router = useRouter()
const isAdmin = computed(() => auth.role === 'admin')
// 退出登录后立即从 KeepAlive 缓存中剔除 ChatView；路由切到登录页时组件按正常卸载路径
// dispose 网关连接，避免已登出的浏览器仍保留对话 WS 与内存中的会话内容。
const cachedViews = computed(() => auth.isAuthenticated ? ['ChatView'] : [])
const loggingOut = ref(false)

async function handleLogout(): Promise<void> {
  if (loggingOut.value) return
  loggingOut.value = true
  try {
    await auth.logout()
    await router.replace('/login')
  } finally {
    loggingOut.value = false
  }
}
</script>

<template>
<div class="app-shell" :class="{ public: $route.meta?.public }">
    <nav v-if="!$route.meta?.public" class="app-nav">
      <span class="nav-brand" data-test="nav-brand">{{ PRODUCT_NAME }}</span>
      <router-link to="/">容器管理</router-link>
      <router-link to="/chat">对话</router-link>
      <router-link to="/sessions">协作会话</router-link>
      <router-link to="/wiki">Wiki</router-link>
      <router-link to="/categories">Categories</router-link>
      <router-link to="/models">Model 配置</router-link>
      <!-- Figure Editor（F1，docs/figure-editor/reconnaissance.md）：常规入口，登录即见（非 admin-only、非 flag-gated）。 -->
      <router-link to="/figure-editor" data-test="nav-figure-editor">Figure Editor</router-link>
      <!-- #800：admin 运营面整体迁入 /admin/ 子应用（独立 MPA 入口）——用户面板 nav 只留
           单一入口（跨应用普通 <a>，非 router-link）；子页面导航归 admin 壳自身。 -->
      <a v-if="isAdmin" href="/admin/" class="nav-admin" data-test="nav-admin-panel">运营面板</a>
      <button
        type="button"
        class="nav-logout"
        data-test="nav-logout"
        :disabled="loggingOut"
        @click="handleLogout"
      >
        {{ loggingOut ? '正在退出…' : '退出登录' }}
      </button>
    </nav>
    <div class="app-content">
      <router-view v-slot="{ Component }">
        <KeepAlive :include="cachedViews">
          <component :is="Component" />
        </KeepAlive>
      </router-view>
    </div>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100svh;
  min-height: 0;
  overflow: hidden;
}
.app-nav {
  display: flex;
  flex: none;
  gap: 18px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--el-border-color);
  background: var(--el-bg-color);
}
.app-nav a {
  color: var(--el-text-color-secondary);
  text-decoration: none;
  font-size: 14px;
}
.app-nav a.router-link-active {
  color: var(--el-color-primary);
  font-weight: 600;
}
/* #800：跨应用入口（运营面板）无 router-link-active 态，hover 与导航同风格 */
.app-nav a.nav-admin:hover {
  color: var(--el-color-primary);
}
.nav-brand {
  font-size: 15px;
  font-weight: 700;
  color: var(--el-color-primary);
  white-space: nowrap;
}
.app-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.nav-logout {
  margin-left: auto;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--el-text-color-secondary);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
.nav-logout:hover {
  color: var(--el-color-primary);
}
.nav-logout:disabled {
  cursor: default;
  opacity: 0.6;
}
@media (max-width: 720px) {
  .app-nav { gap: 12px; padding: 9px 12px; overflow-x: auto; white-space: nowrap; }
  .nav-logout { flex: none; }
}
</style>
