// 沙箱生产装配（#776）：DockerSandboxRuntime（真 docker.sock）+ SandboxLifecycle +
// 闲置 sweeper。由 server.ts 调用；测试不经此（注入 FakeSandboxRuntime + 假时钟）。
// 生命周期服务不接 REST（惰性创建由 runner ingestion/执行面 ensure，#766 D5；级联删由 #778
// 会话 REST 删 session 调 remove）——装配即运行时存在，无入站触发面。

import { config } from '../config'
import { DockerSandboxRuntime } from './dockerRuntime'
import { SandboxLifecycle } from './lifecycle'

export interface SandboxAssembly {
  lifecycle: SandboxLifecycle
  close(): Promise<void>
}

export function assembleSandboxes(): SandboxAssembly {
  const runtime = new DockerSandboxRuntime()
  const lifecycle = new SandboxLifecycle(runtime, { image: config.sandbox.image })
  const stopSweeper = lifecycle.startIdleSweeper()
  return {
    lifecycle,
    close: async () => {
      stopSweeper()
    },
  }
}
