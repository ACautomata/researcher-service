import { defineConfig } from 'vitest/config'

// 接缝 #2（信封 REST 契约）：supertest + 注入临时 SQLite。forks 池隔离每个测试文件进程，
// 每文件独立 temp DB（见 test/setup.ts）→ 无跨文件写竞争。
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    setupFiles: ['./test/env.ts'],
  },
})
