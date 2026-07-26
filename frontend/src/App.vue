<script setup lang="ts"></script>

<template>
  <nav v-if="$route.name !== 'login'" class="app-nav">
    <router-link to="/">容器管理</router-link>
    <router-link to="/chat">对话</router-link>
    <router-link to="/wiki">Wiki</router-link>
    <router-link to="/categories">Categories</router-link>
    <router-link to="/models">Model 配置</router-link>
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
