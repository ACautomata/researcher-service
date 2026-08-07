<script setup lang="ts">
// #340-D（#328）：admin-only nav 条件渲染——仅 me.role==='admin' 时显示「账号管理」入口。
// 守卫本身（meta.requiresAdmin）负责兜底，nav 只是入口隐藏。
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const isAdmin = computed(() => auth.role === 'admin')
</script>

<template>
  <nav v-if="$route.name !== 'login' && !$route.meta.immersive" class="app-nav">
    <router-link to="/">容器管理</router-link>
    <router-link to="/chat">对话</router-link>
    <router-link to="/wiki">Wiki</router-link>
    <router-link to="/categories">Categories</router-link>
    <router-link to="/models">Model 配置</router-link>
    <router-link v-if="isAdmin" to="/admin/users" data-test="nav-admin-users">账号管理</router-link>
    <router-link v-if="isAdmin" to="/admin/trace-logs" data-test="nav-trace-logs">内容消息</router-link>
  </nav>
  <router-view />
</template>

<style scoped>
.app-nav {
  display: flex;
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
</style>
