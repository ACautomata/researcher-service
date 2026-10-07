import { fileURLToPath, URL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vitest/config'

// 联调集成测试（issue #179）：proxy target 读 VITE_API_TARGET——dev 缺省 :8001（TS 控制面，server/）。
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:8001'

// #800 双面板 MPA——/admin/ 分流（dev/preview 形态对齐生产 nginx try_files /admin/ → admin.html）：
// navigation 请求（GET + Accept: text/html）命中 /admin 或 /admin/ 前缀时 rewrite 到 /admin.html，
// admin 子应用（admin.html + src/admin/*）接管路由（base '/admin/'）；非导航请求（静态资源、
// /api）不触碰。生产由 nginx.conf 的 location /admin/ 承担同款分流。
function adminHtmlFallback(): Plugin {
  const rewrite = (
    req: IncomingMessage,
    _res: ServerResponse,
    next: (err?: unknown) => void,
  ): void => {
    const accept = String(req.headers?.accept ?? '')
    const url = req.url ?? ''
    const isNavigation =
      req.method === 'GET' && (accept.includes('text/html') || !accept) && !url.includes('.')
    if (isNavigation && (url === '/admin' || url.startsWith('/admin/'))) {
      req.url = '/admin.html'
    }
    next()
  }
  return {
    name: 'admin-html-fallback',
    configureServer(server) {
      server.middlewares.use(rewrite)
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite)
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue(), adminHtmlFallback()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // 插件目录（#788 · #752 R1）：仓库根级 plugins/<id>/ 源直引（web.ts + Vue 组件）。
      '@plugins': fileURLToPath(new URL('../plugins', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
      },
    },
  },
  server: {
    // dev 下把 /api 代理到 TS 控制面（server/src/config.ts port=8001），前端用相对路径
    // POST /api/v1/auth/login。WS 隧道已随 T0 #801 退役——SSE 事件流走同源 /api，无需 proxy。
    proxy: {
      '/api': apiTarget,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
  },
})
