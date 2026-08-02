// 生产编排装配（#334）：DockerRuntime（真 docker.sock）+ BullMqLifecycleQueue（Redis）
// + FleetDeps + Orchestrator。由 server.ts 调用；测试不经此（注入 FakeRuntime + InlineLifecycleQueue）。

import { config } from '../config'
import type { PrismaClient } from '../generated/prisma/client'
import { DockerRuntime } from './dockerRuntime'
import { BullMqLifecycleQueue } from './bullmqQueue'
import { FleetDeps } from './deps'
import { Orchestrator } from './orchestrator'
import { defaultReservedPorts, type FleetConfig } from './values'

export interface FleetAssembly {
  orchestrator: Orchestrator
  close(): Promise<void>
}

export function assembleFleet(prisma: PrismaClient): FleetAssembly {
  const cfg: FleetConfig = {
    root: config.fleet.root,
    templateDir: config.fleet.templateDir,
    templateJson: config.fleet.templateJson,
    image: config.fleet.image,
    portStart: config.fleet.portStart,
    portEnd: config.fleet.portEnd,
    llmApiKey: config.fleet.llmApiKey,
    publishHost: config.fleet.publishHost,
    healthHost: config.fleet.healthHost,
    reservedPorts: defaultReservedPorts(),
  }
  const runtime = new DockerRuntime(undefined, cfg.publishHost)
  const queue = new BullMqLifecycleQueue({
    redisUrl: config.redisUrl,
    concurrency: config.lifecycleWorkerConcurrency,
  })
  const deps = new FleetDeps(runtime, cfg, { queue })
  const orchestrator = new Orchestrator(deps, prisma)
  return {
    orchestrator,
    close: async () => {
      await queue.close()
    },
  }
}
