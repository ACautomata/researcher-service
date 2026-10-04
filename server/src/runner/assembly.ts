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
import { config } from '../config'
import { wikiContainerName } from '../wikiContainers/runtime'
import { createPrismaApprovalAuditSink } from './approval/audit'
import { ToolCallJudgeClient } from './approval/judge'
import { ApprovalFunnel, type ApprovalFunnelDeps } from './approval/funnel'
import { JUDGE_POLICY_MARKDOWN } from './approval/values'
import { TeammateService } from './teammates/service'

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
  /** wiki 容器生命周期（#784 契约「run 前 ensure」；server.ts 注入 WikiContainerLifecycle 子集） */
  wikis?: NonNullable<RunServiceDeps['wikis']>
  /** 审批漏斗 judge 模型（测试注入 fake；缺省按 config.runner.judge 构造，未配置 = 无 judge） */
  judge?: NonNullable<ApprovalFunnelDeps['judge']>
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
  const teammates = new TeammateService(opts.prisma)

  // 审批三层漏斗（#783）：judge 按部署配置构造（独立小模型，与用户主模型解耦）；审计三层
  // 全量同步写 tool_approval_logs（ADR 0015）。judge 未配置 → 灰区一律升级人工（fail-closed）。
  const judge =
    opts.judge ??
    (config.runner.judge.model !== '' && config.runner.judge.baseUrl !== ''
      ? createJudgeClient()
      : undefined)
  const funnel = new ApprovalFunnel({
    judge,
    audit: createPrismaApprovalAuditSink(opts.prisma),
  })

  const service = new RunService({
    prisma: opts.prisma,
    registry,
    saver,
    gate,
    hub: opts.hub,
    primitives,
    // wiki 容器命名（#784 起经 wikiContainerName 单一来源派生——每用户一台
    // researcher-wiki-<ownerId>；与 wikiContainers/assembly 的创建面同源）。
    resolveWikiContainer: wikiContainerName,
    recursionLimit: opts.recursionLimit,
    sandboxes: opts.sandboxes,
    wikis: opts.wikis,
    approvals: funnel,
    teammates,
    approvalTimeoutMs: config.runner.approvalTimeoutMs,
  })
  void service.recoverSuspensions() // 重启恢复：超时未落定的审批升级 → suspended（异步，不挂启动）

  const queue = new BullMqRunQueue({
    redisUrl: opts.redisUrl,
    execute: (cmd) => service.execute(cmd),
    // worker 并发 = 全局在飞上限（与 gate 同源同值）：gate 是拒绝式（满 → 40043），worker
    // 超领会把本可在 Redis 排队的 run 变成 40043 job failed（attempts:1 不重试、无 run 事件）
    // ——40043 是 Inline/#778 REST 的即时反馈面，不由 worker 面必然触发。
    concurrency: opts.maxConcurrentRuns,
  })
  service.setTeammateDispatcher((cmd, delayMs) => queue.submit(cmd, { delayMs }))
  teammates.setWakeHandler((threadId, teammateId, waitId) => service.wakeMailbox(threadId, teammateId, waitId))

  return {
    service,
    queue,
    close: async () => {
      service.dispose()
      await queue.close()
    },
  }
}

// judge 客户端（部署级独立小模型；729 §2.5）：initChatModel 构造 + 共享 LLM_API_KEY。
// 出口不走 provider_endpoints 白名单——env 是 admin 信任面（config.runner.judge 注释同源）。
function createJudgeClient(): InstanceType<typeof ToolCallJudgeClient> {
  const { model, baseUrl, lcProvider } = config.runner.judge
  return new ToolCallJudgeClient(
    {
      async invoke(messages: unknown[]) {
        const { initChatModel } = await import('langchain/chat_models/universal')
        // temperature 0（729 §2.3：判定确定性面）；JSON mode 不依赖 provider response_format
        //（MiniMax/DeepSeek 兼容面支持参差）——输出契约由 ToolCallJudgeClient 的 zod 校验 +
        // 重试一次 + fail-closed 兑现（同语义，跨端点可移植）。
        const m = await initChatModel(model, {
          modelProvider: lcProvider,
          apiKey: config.runner.llmApiKey,
          temperature: 0,
          ...(lcProvider === 'openai'
            ? { baseUrl, configuration: { fetch: globalThis.fetch } }
            : { clientOptions: { baseURL: baseUrl, fetch: globalThis.fetch } }),
        })
        return m.invoke(messages as never)
      },
    },
    { policy: JUDGE_POLICY_MARKDOWN },
  )
}
