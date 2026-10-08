<script setup lang="ts">
// admin 子应用壳（#800；#881 端点白名单导航随预设制退役）：运营面板导航（账号/审计/Usage/内容消息/API 文档）+
// 回用户面板入口（admin 亦是用户）+ 退出登录（清会话回用户面板登录页）。
// 守卫在 admin/router.ts（decideAdminGuard）：非 admin 根本到不了本壳。
import { ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { PRODUCT_NAME } from '@/product'

const auth = useAuthStore()
const loggingOut = ref(false)

async function handleLogout(): Promise<void> {
  if (loggingOut.value) return
  loggingOut.value = true
  try {
    await auth.logout()
    // 跨应用回用户面板登录页（admin router 无 login 路由）
    window.location.assign('/login')
  } finally {
    loggingOut.value = false
  }
}

// 已登录但只读 state：退出按钮在 logout 后由整页跳转销毁，无需像主面板 App.vue 那样
// 维护 KeepAlive 白名单（admin 页无长连接会话）。
</script>

<template>
  <div class="admin-shell">
    <nav class="admin-nav">
      <span class="nav-brand" data-test="admin-nav-brand">{{ PRODUCT_NAME }} · 运营管理台</span>
      <router-link to="/" data-test="admin-nav-users" exact-active-class="active">账号管理</router-link>
      <router-link to="/audit" data-test="admin-nav-audit">审计检索</router-link>
      <router-link to="/usage" data-test="admin-nav-usage">Usage 核算</router-link>
      <router-link to="/trace-logs" data-test="admin-nav-trace-logs">内容消息</router-link>
      <router-link to="/docs" data-test="admin-nav-docs">API 文档</router-link>
      <!-- admin 亦是用户：跨应用回本人工作面（普通 <a>，非 router-link——用户面板是另一个 MPA 入口） -->
      <a href="/" class="nav-user-panel" data-test="admin-nav-user-panel">用户面板</a>
      <button
        type="button"
        class="nav-logout"
        data-test="admin-nav-logout"
        :disabled="loggingOut"
        @click="handleLogout"
      >
        {{ loggingOut ? '正在退出…' : '退出登录' }}
      </button>
    </nav>
    <div class="admin-content">
      <router-view />
    </div>
  </div>
</template>

<style scoped>
.admin-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100svh;
  min-height: 0;
  overflow: hidden;
}
.admin-nav {
  display: flex;
  flex: none;
  gap: 18px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--el-border-color);
  background: var(--el-bg-color);
}
.admin-nav a {
  color: var(--el-text-color-secondary);
  text-decoration: none;
  font-size: 14px;
}
.admin-nav a.router-link-active {
  color: var(--el-color-primary);
  font-weight: 600;
}
.nav-brand {
  font-size: 15px;
  font-weight: 700;
  color: var(--el-color-primary);
  white-space: nowrap;
}
.nav-user-panel {
  margin-left: auto;
}
.nav-logout {
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
@media (max-width: 860px) {
  .admin-nav { gap: 12px; padding: 9px 12px; overflow-x: auto; white-space: nowrap; }
  .nav-user-panel { margin-left: 0; }
}
</style>
