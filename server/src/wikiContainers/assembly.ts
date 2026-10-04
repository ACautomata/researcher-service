// wiki 容器生产装配（#784）：DockerWikiContainerRuntime（真 docker.sock）+
// WikiContainerLifecycle。由 server.ts 调用；测试不经此（注入 FakeWikiContainerRuntime）。
// 消费面：wiki 域 REST（ensure——create/health 合一）与 runner（run 前 ensure，沙箱 ensure
// 同款接缝）。永久容器无 sweeper（沙箱闲置回收的刻意缺席面）——close 仅存句柄对称性。

import { config } from '../config'
import { DockerWikiContainerRuntime } from './dockerRuntime'
import { WikiContainerLifecycle } from './lifecycle'

export interface WikiContainersAssembly {
  lifecycle: WikiContainerLifecycle
  close(): Promise<void>
}

export function assembleWikiContainers(): WikiContainersAssembly {
  const runtime = new DockerWikiContainerRuntime()
  const lifecycle = new WikiContainerLifecycle(runtime, { image: config.wikiContainers.image })
  return {
    lifecycle,
    close: async () => {},
  }
}
