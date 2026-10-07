// 生产编排装配（#334）：DockerRuntime（真 docker.sock）+ BullMqLifecycleQueue（Redis）
// + FleetDeps + Orchestrator。由 server.ts 调用；测试不经此（注入 FakeRuntime + InlineLifecycleQueue）。
// T0 #801 legacy 清退：端口池/探针/隧道寻址配置随组件退役，FleetConfig 收缩。

import { config } from '../config'
import type { PrismaClient } from '../generated/prisma/client'
import { DockerRuntime } from './dockerRuntime'
import { BullMqLifecycleQueue } from './bullmqQueue'
import { FleetDeps } from './deps'
import { Orchestrator } from './orchestrator'
import { DockerFileArchive } from '../files/dockerArchive'
import type { FileArchive } from '../files/fsPort'
import type { FleetConfig } from './values'

export interface FleetAssembly {
  orchestrator: Orchestrator
  // runtime 暴露：docker exec/inspect 通道（fleet 生命周期编排）。
  runtime: DockerRuntime
  // FileArchive：seedWorkspace 灌模板卷 + files 域沙箱只读读面（lab）共用
  archive: FileArchive
  close(): Promise<void>
}

export function assembleFleet(prisma: PrismaClient): FleetAssembly {
  const cfg: FleetConfig = {
    root: config.fleet.root,
    templateDir: config.fleet.templateDir,
    image: config.fleet.image,
    llmApiKey: config.fleet.llmApiKey,
    namedVolumes: config.fleet.namedVolumes,
    encryptionKeys: config.fleet.encryptionKeys,
  }
  const runtime = new DockerRuntime()
  const archive = new DockerFileArchive()
  const queue = new BullMqLifecycleQueue({
    redisUrl: config.redisUrl,
    concurrency: config.lifecycleWorkerConcurrency,
  })
  const deps = new FleetDeps(runtime, cfg, { queue, archive })
  const orchestrator = new Orchestrator(deps, prisma)
  return {
    orchestrator,
    runtime,
    archive,
    close: async () => {
      await queue.close()
    },
  }
}
