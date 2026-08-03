import { defineConfig } from 'vitest/config'

// 接缝 #2（信封 REST 契约）：supertest + 注入临时 SQLite。forks 池隔离每个测试文件进程，
// 每文件独立 temp DB（见 test/setup.ts）→ 无跨文件写竞争。
// maxForks=4（预存在 flaky 修复）：containers-smoke 真跑（真实 DockerRuntime + dockerd 镜像
// 操作）叠加 10 并发 fork + 系统负载（iCloud 同步等），CPU 饥饿短时风暴 → 随机测试超时
// （5000ms testTimeout 太紧，单独跑任何文件全绿）。降并发到 4 给 dockerd/系统留 CPU 余量；
// 实测压力（load>100）下默认 3 轮全红、maxForks=4 全绿，且全量时长仍 ~30s（不拖慢）。
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
        maxForks: 4,
        minForks: 4,
      },
    },
    setupFiles: ['./test/env.ts'],
  },
})
