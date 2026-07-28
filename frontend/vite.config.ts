import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// 联调集成测试（issue #179）：proxy target 读 VITE_API_TARGET——dev 缺省 :8000 行为不变，
// 测试时由 backend conftest 注入 pytest-django live server 随机端口（端口隔离得以保留）。
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:8000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // dev 下把 /api 代理到 Django，前端用相对路径 POST /api/v1/auth/login
    // /ws/chat/ 经 Channels（Daphne/asgi）—— 需开 ws 代理，否则 Vite 拦截 /ws 连不上后端（codex P2）
    proxy: {
      '/api': apiTarget,
      '/ws': { target: apiTarget, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
  },
})
