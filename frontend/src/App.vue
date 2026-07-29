<script setup lang="ts">
// issue #202 问题5：导航栏补登出入口（auth.logout 此前无任何 UI 调用方）
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()

async function onLogout(): Promise<void> {
  await auth.logout()
  await router.push('/login')
}
</script>

<template>
  <nav v-if="$route.name !== 'login'" class="app-nav">
    <router-link to="/">容器管理</router-link>
    <router-link to="/chat">对话</router-link>
    <router-link to="/wiki">Wiki</router-link>
    <router-link to="/categories">Categories</router-link>
    <router-link to="/models">Model 配置</router-link>
    <button class="logout" data-test="logout" @click="onLogout">登出</button>
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
.logout {
  margin-left: auto;
  border: none;
  background: none;
  padding: 0;
  color: var(--el-text-color-secondary);
  font-size: 14px;
  cursor: pointer;
}
.logout:hover {
  color: var(--el-color-primary);
}
</style>
