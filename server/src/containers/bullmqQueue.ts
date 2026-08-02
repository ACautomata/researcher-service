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
  // Redis 断连 / 协议错误 / 命令失败的统一上报（Codex C7）。默认 console.error；生产可注入日志/告警。
  // 仅记录上报，不阻断 ioredis / BullMQ 自身的自动重连。
  onError?: (err: Error) => void
  // producer 提交超时 ms（Codex 第七轮 #1）：BullMQ 强制 producer connection maxRetriesPerRequest:null，
  // Redis 不可达时 queue.add 永挂——submit 永挂致 detached create 的 name lease 永不释放、行卡 creating。
  // 给 add 套超时兜底：预算内未 settle 即视入队失败，清两表 + reject（caller 补偿释放 lease/标 error）。
  // 默认 5000ms；测试可注入小值快速复现。
  addTimeoutMs?: number
  // worker.close 有界超时 ms（Codex 第七轮 #3）：close() await worker.close drain 在跑 job，但坏
  // Redis 上 worker.close 可能挂起——超时兜底防 shutdown 卡死须 SIGKILL（保留原 detach 的安全侧）。
  // 默认 5000ms。
  workerCloseTimeoutMs?: number
}

interface PendingTask {
  task: LifecycleTask
  resolve: () => void
  reject: (e: unknown) => void
}

export class BullMqLifecycleQueue implements LifecycleQueue {
  // readonly public（Codex C7）：消费者/测试可监听额外事件、验证 error listener 接线。
  readonly queue: Queue
  readonly worker: Worker
  readonly connection: IORedis
  // 任务/结果注册表（同进程：submit 与 worker processor 共享一个 Node 进程）。
  // readonly public（Codex 第六轮 P2）：测试可断言入队失败时两表清理（与 queue/worker/connection 同先例）。
  readonly tasks = new Map<string, LifecycleTask>()
  // 存 {resolve,reject}：completed → resolve；最终失败 → reject（解挂 submit 的 awaiter，
  // 否则永久失败 job 让 awaiter 永不 settle，连带卡死该 name 的 per-name 串行链）。
  readonly pending = new Map<string, Pick<PendingTask, 'resolve' | 'reject'>>()
  // producer 提交超时（Codex 第七轮 #1）：见 BullMqLifecycleOptions.addTimeoutMs。
  readonly addTimeoutMs: number
  readonly workerCloseTimeoutMs: number

  constructor(opts: BullMqLifecycleOptions) {
    const queueName = opts.queueName ?? 'container-lifecycle'
    this.addTimeoutMs = opts.addTimeoutMs ?? 5000
    this.workerCloseTimeoutMs = opts.workerCloseTimeoutMs ?? 5000
    this.connection = new IORedis(opts.redisUrl, { maxRetriesPerRequest: null })
    this.queue = new Queue(queueName, { connection: this.connection })
    this.worker = new Worker(
      queueName,
      async (job: Job) => {
        const task = this.tasks.get(String(job.id))
        if (!task) {
          // 崩溃重启后 stalled/queued job 重跑：任务句柄已失（进程置换）。BullMQ 移除此 job，
          // 行状态由 readModel.reconcileCreating/reconcileRemoving 在 list 读路径 lazy 对账收敛
          // （Codex C6）——不再静默 success：明确记录，避免 lifecycle 操作未执行被无声吞没。
          // eslint-disable-next-line no-console
          console.warn(
            `[bullmq] lifecycle job ${job.id} had no in-process task (process restarted?) — leaving row to reconciliation`,
          )
          return
        }
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
    // error listener（Codex C7）：Worker/Queue/IORedis connection 均为 EventEmitter，'error' 事件
    // 无 listener 即抛 uncaughtException → 崩整个 API 进程（一次 Redis 抖动即致命）。
    // 注册 listener 记录/上报，ioredis（maxRetriesPerRequest:null + 自动重连）与 BullMQ 继续自愈。
    const onError = opts.onError ?? ((err: Error) => {
      // eslint-disable-next-line no-console
      console.error('[bullmq] lifecycle queue error', err)
    })
    this.connection.on('error', onError)
    this.queue.on('error', onError)
    this.worker.on('error', onError)
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
    try {
      await this.raceAddTimeout(
        this.queue.add('lifecycle', {}, { jobId: id, attempts: 3, backoff: { type: 'fixed', delay: 500 } }),
      )
    } catch (e) {
      // 入队失败（Redis ACL / 只读 / 命令错误，Codex 第六轮 P2）：queue.add reject 时 worker 永不消费
      // 此 job，completed/failed listener 不会触发——tasks/pending 残留致内存泄漏（持续 Redis 故障下每次
      // submit 累积一对条目）。删除两表条目后 rethrow（caller 的 await 经此 reject 感知失败；
      // done promise 不再被 await 故无须 reject，直接删除即可）。
      this.tasks.delete(id)
      this.pending.delete(id)
      throw e
    }
    await done
  }

  // producer 提交超时（Codex 第七轮 #1）：queue.add 在 maxRetriesPerRequest:null 下 Redis 不可达时永挂。
  // 套超时兜底：预算内未 settle 即 reject（submit 的 catch 清两表 + rethrow，caller 补偿释放 lease/
  // 标 error）。底层 addP 此后仍 pending；worker 恢复消费时 tasks 已空 → if(!task) return 对账收敛，
  // 不重复执行。BullMQ 强制 producer connection 的 maxRetriesPerRequest:null，无法改有限重试预算，
  // 故用提交超时而非连接重试上限。
  private raceAddTimeout(addP: Promise<unknown>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('bullmq queue.add 超时（Redis 不可达？）')),
        this.addTimeoutMs,
      )
      addP.then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        },
      )
    })
  }

  async start(): Promise<void> {
    await this.worker.waitUntilReady()
  }

  async close(): Promise<void> {
    // 优雅关闭：drain 在飞任务 + 防坏 Redis 卡死（Codex 第七轮 #3）。修前 worker.close() detach
    // （不 await）——fleet.close() resolve 后 server.close() 即可 process.exit(0)，中断仍在跑的生命周期
    // job（每次滚动重启都丢在跑 provisioning/deletion，非仅 Redis 故障路径）。改 await worker.close drain，
    // 但套有界超时：坏 Redis 上 worker.close 可能挂起，超时兜底防 shutdown 卡死须 SIGKILL（保留原 detach
    // 的安全侧）。先 disconnect connection 让 worker/queue 失去传输后能快速收尾。
    this.connection.disconnect()
    await this.queue.close().catch(() => {})
    await this.raceWorkerClose()
  }

  // worker.close 有界超时（Codex 第七轮 #3）：await drain 在跑 job，超时则放行防卡死。
  private raceWorkerClose(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.workerCloseTimeoutMs)
      this.worker
        .close()
        .catch(() => {})
        .then(() => {
          clearTimeout(timer)
          resolve()
        })
    })
  }
}
