// runner 生产装配（#777 · #747 A 节「集中式 runner」）：
// PrismaCheckpointSaver + ProviderRegistry + ConcurrencyGate + StreamHub + DockerPrimitives
// → RunService → BullMqRunQueue（worker 消费）。REST 入队面归 #778 会话域（本票生产接线 =
// 进程内就绪 + 事件经 hub 扇出）。装配失败语义对齐 fleet 队列先例：BullMQ 连接 lazy，
// Redis 不可达不挂控制面（add 超时兜底在队列层）。

import type { PrismaClient } from '../generated/prisma/client'
import type { StreamHub } from '../events/hub'
import type { RunServiceDeps } from './runtime/runService'
import { PrismaCheckpointSaver } from './persistence/prismaCheckpointSaver'
import { ProviderRegistry } from './providerRegistry'
import { ConcurrencyGate } from './concurrency'
import { DockerPrimitives } from './backend/dockerPrimitives'
import { RunService } from './runtime/runService'
import { BullMqRunQueue } from './bullmqRunQueue'
import { disableLangsmithTracing } from './runtime/tracing'
import { installAbortRejectionGuard } from './runtime/abortGuard'

export interface RunnerAssembly {
  readonly service: RunService
  readonly queue: BullMqRunQueue
  close: () => Promise<void>
}

export function assembleRunner(opts: {
  prisma: PrismaClient
  hub: StreamHub
  redisUrl: string
  maxConcurrentRuns: number
  recursionLimit?: number
  /** 沙箱生命周期（#776 契约「消费方 = #777 runner ensure/touch」；类型面复用 RunServiceDeps） */
  sandboxes?: NonNullable<RunServiceDeps['sandboxes']>
}): RunnerAssembly {
  // tracing 显式关（启动期第一路；RunService 构造期第二路兜底）
  disableLangsmithTracing()
  // LangGraph abortPromise 泄漏守门（用户 abort run 的进程级 crash 面，见 abortGuard.ts）
  installAbortRejectionGuard()

  const saver = new PrismaCheckpointSaver(opts.prisma)
  const registry = new ProviderRegistry(opts.prisma)
  const gate = new ConcurrencyGate({
    globalLimit: opts.maxConcurrentRuns,
    // users.maxConcurrentRuns 即读（admin 可改即时生效；坏列值 gate 层按 0 拒绝保护面）
    loadUserLimit: async (ownerId) => {
      const u = await opts.prisma.user.findUnique({
        where: { id: ownerId },
        select: { maxConcurrentRuns: true },
      })
      return u?.maxConcurrentRuns ?? 0
    },
  })
  const primitives = new DockerPrimitives()

  const service = new RunService({
    prisma: opts.prisma,
    registry,
    saver,
    gate,
    hub: opts.hub,
    primitives,
    // wiki 容器命名（#784 双容器 orchestrator 接管前的占位实现——每用户一台，命名即预言；
    // 当前生产 wiki 容器不存在，/wiki/ 工具路径的文件操作会因容器缺失报错回流 agent 自纠，
    // /lab/ 面不受影响。#784 落地后替换为 orchestrator 查询）。
    resolveWikiContainer: (ownerId) => `researcher-wiki-${ownerId}`,
    recursionLimit: opts.recursionLimit,
    sandboxes: opts.sandboxes,
  })

  const queue = new BullMqRunQueue({
    redisUrl: opts.redisUrl,
    execute: (cmd) => service.execute(cmd),
    // worker 并发 = 全局在飞上限（与 gate 同源同值）：gate 是拒绝式（满 → 40043），worker
    // 超领会把本可在 Redis 排队的 run 变成 40043 job failed（attempts:1 不重试、无 run 事件）
    // ——40043 是 Inline/#778 REST 的即时反馈面，不由 worker 面必然触发。
    concurrency: opts.maxConcurrentRuns,
  })

  return {
    service,
    queue,
    close: () => queue.close(),
  }
}
