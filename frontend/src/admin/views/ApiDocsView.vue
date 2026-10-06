<script setup lang="ts">
// API 文档面（#761 · admin-only）：Swagger UI 渲染后端 zod 生成式 OpenAPI 3.1 文档。
//
// 为什么不在浏览器直开 /api/docs：后端文档面门控是 Authorization Bearer（requireAuth +
// requireAdmin），浏览器地址栏进不了 header。故 admin 入口走本视图——spec 经 apiFetch 认证链
// 拉取（401 刷新重试/跳登录自动生效；openapi.json 是裸 JSON 不包 #312 信封，apiJson 非信封
// 透传分支原样返回），SwaggerUIBundle 直接吃注入的 spec；TryIt 的请求经 requestInterceptor
// 注入同一 token。Swagger UI 静态资源经 npm 打包（swagger-ui-dist），不经 /api/docs 静态端点
// （那个面在 Bearer-only 下浏览器同样到不了）。
import { onMounted, onBeforeUnmount, ref } from 'vue'
import SwaggerUI from 'swagger-ui-dist/swagger-ui-bundle.js'
import 'swagger-ui-dist/swagger-ui.css'
import { apiJson } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { ApiError } from '@/api/errors'

const auth = useAuthStore()
const el = ref<HTMLElement | null>(null)
const loadError = ref('')
let ui: { destroy?: () => void } | null = null

onMounted(async () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spec = (await apiJson<any>('/api/docs/openapi.json')) as any
    // requestInterceptor 对 TryIt 请求与（备用）url 加载统一生效；本组件用注入 spec，
    // 拦截器只服务 TryIt——401 由 swagger-ui 原样呈现（docs 面是 admin 工具，不叠加刷新链）。
    ui = SwaggerUI({
      spec,
      domNode: el.value ?? undefined,
      requestInterceptor: (req) => {
        if (auth.token) req.headers.Authorization = `Bearer ${auth.token}`
        return req
      },
      docExpansion: 'none',
    })
  } catch (e) {
    loadError.value = e instanceof ApiError ? `${e.code ?? e.status}：${e.message}` : String(e)
  }
})

onBeforeUnmount(() => {
  ui?.destroy?.()
  ui = null
})
</script>

<template>
  <div class="api-docs">
    <h1>API 文档</h1>
    <p class="api-docs__hint">OpenAPI 3.1 · 由后端 zod schema 生成（零漂移）· 仅 admin 可见</p>
    <el-alert v-if="loadError" type="error" :title="`文档加载失败：${loadError}`" data-test="docs-error" />
    <div v-show="!loadError" ref="el" class="api-docs__swagger" data-test="swagger-container" />
  </div>
</template>

<style scoped>
.api-docs {
  padding: 16px 24px;
  max-width: 1200px;
  margin: 0 auto;
}
.api-docs__hint {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin: 4px 0 16px;
}
/* swagger-ui 自带排版在 scoped 样式下需穿透 */
.api-docs__swagger :deep(.swagger-ui) {
  font-family: inherit;
}
</style>
