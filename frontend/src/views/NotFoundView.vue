<template>
  <main class="not-found" data-test="not-found">
    <p class="status">404</p>
    <h1>页面不存在</h1>
    <p>你访问的地址不存在，或页面已被移动。</p>
    <router-link class="back" to="/">返回容器管理</router-link>
  </main>
</template>

<style scoped>
.not-found {
  display: grid;
  place-content: center;
  justify-items: center;
  min-height: min(70vh, 640px);
  padding: 32px;
  text-align: center;
}
.status {
  margin: 0;
  color: var(--el-color-primary);
  font-size: clamp(48px, 8vw, 88px);
  font-weight: 700;
  line-height: 1;
}
.not-found h1 {
  margin: 16px 0 8px;
}
.not-found p:not(.status) {
  margin: 0;
  color: var(--el-text-color-secondary);
}
.back {
  margin-top: 24px;
  color: var(--el-color-primary);
}
</style>
