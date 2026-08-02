// BullMQ 生产生命周期队列（#313 并发模型：BullMQ(Redis) 后台队列 + worker 并发上限 + stalled 重跑）。
// 对齐旧 ThreadPoolExecutor(2) 的并发上限；BullMQ 自带 stalled-job 崩溃重跑（worker 崩溃的 job
// 重新入队执行），补 provisioning 中断的对账缺口。任务在同进程内经注册表传递（#313 单进程模型，
// Redis 只做调度/崩溃恢复，不做跨进程任务分发）。

import { randomUUID } from 'node:crypto'
import { Queue, Worker, type Job } from 'bullmq'
import IORedis from 'ioredis'
import type { LifecycleQueue, LifecycleTask } from './lifecycleQueue'

export interface BullMqLifecycleOptions {
  redisUrl: string
  concurrency: number
  queueName?: string
}

interface PendingTask {
  task: LifecycleTask
  resolve: () => void
  reject: (e: unknown) => void
}

export class BullMqLifecycleQueue implements LifecycleQueue {
  private readonly queue: Queue
  private readonly worker: Worker
  private readonly connection: IORedis
  // 任务/结果注册表（同进程：submit 与 worker processor 共享一个 Node 进程）。
  private readonly tasks = new Map<string, LifecycleTask>()
  // 存 {resolve,reject}：completed → resolve；最终失败 → reject（解挂 submit 的 awaiter，
  // 否则永久失败 job 让 awaiter 永不 settle，连带卡死该 name 的 per-name 串行链）。
  private readonly pending = new Map<string, Pick<PendingTask, 'resolve' | 'reject'>>()

  constructor(opts: BullMqLifecycleOptions) {
    const queueName = opts.queueName ?? 'container-lifecycle'
    this.connection = new IORedis(opts.redisUrl, { maxRetriesPerRequest: null })
    this.queue = new Queue(queueName, { connection: this.connection })
    this.worker = new Worker(
      queueName,
      async (job: Job) => {
        const task = this.tasks.get(String(job.id))
        if (!task) return // 崩溃重启后 job 重跑但任务句柄已失（进程置换）——跳过，由行状态兜底对账
        await task()
      },
      { connection: this.connection, concurrency: opts.concurrency },
    )
    this.worker.on('completed', (job) => {
      this.tasks.delete(String(job.id))
      this.pending.get(String(job.id))?.resolve()
      this.pending.delete(String(job.id))
    })
    this.worker.on('failed', (job, err) => {
      if (!job) return
      // 每次 attempt 失败都触发；仅终态失败（attempts 用尽）才 settle，避免首次重试误放。
      if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
        this.tasks.delete(String(job.id))
        // 行已由 createComplete/delete 标 ERROR/REMOVING 兜底；此处 reject 解挂 submit 的
        // awaiter，错误沿 serializer 链（.catch 兜底）传播，不阻断后续排队任务。
        this.pending.get(String(job.id))?.reject(err)
        this.pending.delete(String(job.id))
      }
    })
  }

  async submit(task: LifecycleTask): Promise<void> {
    // jobId 须全局唯一：进程重启后 PID 常复位（容器内 PID 1），自增 seq 也归零，而 BullMQ 默认
    // 保留已完成 job——复用的 ID 会被当作既有 completed job 跳过调度，done promise 永不 settle，
    // 该 name 的 per-name 串行链永久挂死、行卡 creating/removing。randomUUID 跨重启全局唯一。
    const id = randomUUID()
    this.tasks.set(id, task)
    const done = new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    // attempts 给 stalled/崩溃重跑留余地；backoff 固定小延迟。
    await this.queue.add('lifecycle', {}, { jobId: id, attempts: 3, backoff: { type: 'fixed', delay: 500 } })
    await done
  }

  async start(): Promise<void> {
    await this.worker.waitUntilReady()
  }

  async close(): Promise<void> {
    await this.worker.close()
    await this.queue.close()
    this.connection.disconnect()
  }
}
