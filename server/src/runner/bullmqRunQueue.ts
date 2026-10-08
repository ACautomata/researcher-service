// BullMQ 生产 run 队列（#777 · #747 A 节「集中式 runner：BullMQ worker」）。
//
// 与 containers/bullmqQueue.ts（生命周期队列）的分野：run 命令是**自包含 JSON data**
//（RunCommand，无进程内任务句柄注册表）——进程内状态可全弃，凭 DB 重投即 run 从头重跑
//（副作用幂等约束在案，#747 A 节硬约束）。attempts:1 下失败 job 直接 failed 不重跑；
// 断线补偿与重投归 #779（normalizeReplay，见下）。同 thread 串行不在本层（BullMQ OSS 无
// per-group 限流，worker 可并发领同 thread job）——顺序性由 RunService 进程内串行链保证
//（#723 风险条目「BullMQ per-thread 串行是全部责任」）。
//
// 失败语义：processor 内 run 执行错误已在 RunService 消化（终态事件已发，对 job 表现为
// 成功）；信封错误（REST 已即时反馈的竞态码：40043 额度满 / 50001 resume 竞态 / 50002 会话
// 不存在 / 50003 interrupt 门禁）冒泡为 job failed——V1 attempts 默认 1 不重试（额度等待/
// 重投语义归 #778 REST 层即时反馈面，job 级重跑 = run 从头执行会产生重复用户可见事件，故不开）。
// 其余 pre-start 失败（LLM 装配/容器 ensure/registry）由 RunService.executeNow catch 补
// run.failed{errorKind} 后仍冒泡 job failed（story 10 不无声挂死）。onError 统一上报（先例 Codex C7）。
//
// stalled 重放（story 14 · #779 探针实测）：worker 崩溃（进程死）时在飞 job 的 lock 残留，
// 新 worker 的 stalled check 将其**移回 wait 自动重放**（BullMQ v6：绕过 attempts:1——
// stalled 是独立于 attempts 的恢复机制）。重放 message 会重复 append 用户消息、重放 resume
// 会被互斥判定误拒 50001——拦截归 RunService.normalizeReplay（checkpoint 判据 → kind 转
// 'recover'，从 checkpoint 续跑）。本层零特判：重放对 processor 透明（同 job 同 data 二次
// 执行）。

import { Queue, Worker, type Job } from 'bullmq'
import IORedis from 'ioredis'
import { raceWithTimeout } from '../raceTimeout'
import type { RunCommand } from './runtime/runService'

export interface BullMqRunQueueOptions {
  readonly redisUrl: string
  /** run 执行体（生产 = RunService.execute） */
  readonly execute: (cmd: RunCommand) => Promise<void>
  readonly concurrency?: number
  readonly queueName?: string
  /** Redis 断连/协议错误/命令失败的统一上报；仅记录不阻断自动重连（先例 Codex C7） */
  readonly onError?: (err: Error) => void
  /** producer 提交超时 ms（先例 bullmqQueue.ts：Redis 不可达时 add 永挂的兜底；默认 5000） */
  readonly addTimeoutMs?: number
  /** worker.close 有界超时 ms（坏 Redis 上防 shutdown 卡死；默认 5000） */
  readonly workerCloseTimeoutMs?: number
}

function defaultOnError(err: Error): void {
  // eslint-disable-next-line no-console
  console.error(`[runner] bullmq error: ${err.message}`)
}

export class BullMqRunQueue {
  readonly queue: Queue<RunCommand>
  readonly worker: Worker<RunCommand>
  readonly connection: IORedis
  private readonly addTimeoutMs: number
  private readonly workerCloseTimeoutMs: number
  private readonly reportError: (err: Error) => void

  constructor(opts: BullMqRunQueueOptions) {
    this.reportError = opts.onError ?? defaultOnError
    this.addTimeoutMs = opts.addTimeoutMs ?? 5000
    this.workerCloseTimeoutMs = opts.workerCloseTimeoutMs ?? 5000
    // producer 面连接：maxRetriesPerRequest=null 是 BullMQ 对 connection 的强制要求
    //（不加则 add 在 Redis 不可达时以命令重试拒绝而非排队）；永挂面由 addTimeoutMs 兜底。
    this.connection = new IORedis(opts.redisUrl, { maxRetriesPerRequest: null })
    this.queue = new Queue<RunCommand>(opts.queueName ?? 'runner-runs', { connection: this.connection })
    this.worker = new Worker<RunCommand>(
      this.queue.name,
      async (job: Job<RunCommand>) => {
        await opts.execute(job.data)
      },
      { connection: this.connection, concurrency: opts.concurrency ?? 4 },
    )
    this.worker.on('failed', (job, err) => {
      if (!job) return
      this.reportError(new Error(`run job ${job.id} failed: ${err.message}`))
    })
    this.worker.on('error', (err) => {
      this.reportError(err)
    })
  }

  // 入队一个 run 命令（jobId = runId：幂等面——同 runId 重复 submit 被 BullMQ 去重）。
  // 超时即向上抛（调用方感知失败）——底层 add 此后仍 pending（坏 Redis 永挂面），但
  // Promise.race 已订阅其 handlers，后续 rejection 不会成为 unhandledRejection；等待其
  // settle 反而架空 addTimeoutMs（永挂场景下 submit 永不返回）。对齐 fleet raceAddTimeout。
  async submit(cmd: RunCommand, opts: { delayMs?: number } = {}): Promise<void> {
    const add = this.queue.add('run', cmd, {
      jobId: cmd.runId,
      attempts: 1,
      ...(opts.delayMs && opts.delayMs > 0 ? { delay: opts.delayMs } : {}),
    })
    await raceWithTimeout(add, this.addTimeoutMs, () =>
      new Error(`runner queue.add timeout (${this.addTimeoutMs}ms)`),
    )
  }

  async close(): Promise<void> {
    await raceWithTimeout(
      this.worker.close().catch(() => undefined),
      this.workerCloseTimeoutMs,
    )
    await this.queue.close().catch(() => undefined)
    this.connection.disconnect()
  }
}
