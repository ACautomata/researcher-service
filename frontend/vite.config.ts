import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// 联调集成测试（issue #179）：proxy target 读 VITE_API_TARGET——dev 缺省 :8001（TS 控制面，server/）。
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:8001'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // dev 下把 /api 代理到 TS 控制面（server/src/config.ts port=8001），前端用相对路径
    // POST /api/v1/auth/login；/ws/chat/ 经同一控制面的隧道（server.ts 同端口 upgrade 分流）。
    proxy: {
      '/api': apiTarget,
      '/ws': { target: apiTarget, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
  },
})
