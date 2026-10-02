// BullMQ 生产 run 队列（#777 · #747 A 节「集中式 runner：BullMQ worker」）。
//
// 与 containers/bullmqQueue.ts（生命周期队列）的分野：run 命令是**自包含 JSON data**
//（RunCommand，无进程内任务句柄注册表）——worker 崩溃后 stalled job 重跑 = run 从头重跑
//（副作用幂等约束在案，#747 A 节硬约束），checkpoint 断点续跑的细粒度恢复归 #779 断线补偿。
// 同 thread 串行不在本层（BullMQ OSS 无 per-group 限流，worker 可并发领同 thread job）——
// 顺序性由 RunService 进程内串行链保证（#723 风险条目「BullMQ per-thread 串行是全部责任」）。
//
// 失败语义：processor 内 run 执行错误已在 RunService 消化（终态事件已发，对 job 表现为
// 成功）；信封错误（40043 额度满 / 50001 resume 竞态 / 50002 会话不存在）冒泡为 job failed
// ——V1 attempts 默认 1 不重试（额度等待/重投语义归 #778 REST 层即时反馈面，job 级重跑 =
// run 从头执行会产生重复用户可见事件，故不开）。onError 统一上报（先例 Codex C7）。

import { Queue, Worker, type Job } from 'bullmq'
import IORedis from 'ioredis'
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
  async submit(cmd: RunCommand): Promise<void> {
    const add = this.queue.add('run', cmd, { jobId: cmd.runId, attempts: 1 })
    const timeout = new Promise<never>((_, rej) => {
      const t = setTimeout(() => rej(new Error(`runner queue.add timeout (${this.addTimeoutMs}ms)`)), this.addTimeoutMs)
      // 不持有 timer 引用阻止进程退出（settle 后由 GC 收）
      t.unref?.()
    })
    try {
      await Promise.race([add, timeout])
    } catch (e) {
      await add.catch(() => undefined) // 超时后 add 仍可能落库——尽力等待其 settle 防未处理 rejection
      throw e
    }
  }

  async close(): Promise<void> {
    const closeWorker = this.worker.close().catch(() => undefined)
    const timeout = new Promise<void>((res) => {
      const t = setTimeout(res, this.workerCloseTimeoutMs)
      t.unref?.()
    })
    await Promise.race([closeWorker, timeout])
    await this.queue.close().catch(() => undefined)
    this.connection.disconnect()
  }
}
