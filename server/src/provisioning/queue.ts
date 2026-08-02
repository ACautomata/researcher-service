import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq'
import IORedis from 'ioredis'
import { randomUUID } from 'node:crypto'
import { config } from '../config'
import type { Orchestrator, ProvisionJobQueue } from '../orchestrator/orchestrator'

// BullMQ provisioning 队列（#334 M2 · #313 并发模型）。
//
// codex #1（P1）：BullMQ 的 `jobId` 是**去重**不是**串行**——同名 job 在 wait/active/failed 时
// `add` 静默丢弃，不追加操作。create+delete 共用 jobId=name 会让「delete 追着 pending create」
// 被吞（进程重启清空内存租约后尤其危险：delete 静默丢，行永远留在 creating）。故：
// - 每个 job 用**唯一 jobId**（`create:<name>:<uuid>` / `delete:<name>:<uuid>`），绝不共用槽位；
// - **按 name 串行**改由 worker 端 promise-chain 互斥实现（进程内 Map<name, tailPromise>，
//   同名 job 依序 await），不依赖 Redis；跨进程仍由 DB 状态（creating/running/removing +
//   cancelRequested）仲裁，worker 幂等 no-op 兜底。
// - `removeOnComplete` 仅清成功；失败 job 保留（默认），下次同操作可重试（不依赖失败去重）。

export const QUEUE_NAME = 'openclaw-provision'

export interface CreateJobData {
  type: 'create'
  name: string
  ownerId: string
  configText: string
}

export interface DeleteJobData {
  type: 'delete'
  name: string
  ownerId: string
  rowId: string // codex 四轮 P1：绑定保留的行 ID——BullMQ at-least-once，重试不得删新重建的同名行
}

export type ProvisionJobData = CreateJobData | DeleteJobData

// worker 端按 name 串行：同名 job 依 promise-chain 排队（进程内互斥，不依赖 Redis）。
// 崩溃即随进程消失；跨进程由 DB 状态仲裁（幂等 no-op）。
class PerNameChain {
  private readonly tails = new Map<string, Promise<unknown>>()

  /** 串行执行 fn（同名操作依序 await；异名并发不受限） */
  run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(name) ?? Promise.resolve()
    const next = prev.then(fn, fn) // 前序失败不阻塞后续（各自独立补偿）
    this.tails.set(name, next.catch(() => {})) // 存吞错尾，防未处理拒绝
    return next
  }
}

// 真实 BullMQ 队列适配（生产装配；测试注入内存 fake 不触 Redis）。
export class BullMqProvisionQueue implements ProvisionJobQueue {
  private readonly queue: Queue<ProvisionJobData>

  constructor(connection: ConnectionOptions) {
    this.queue = new Queue<ProvisionJobData>(QUEUE_NAME, { connection })
  }

  async enqueueCreate(name: string, ownerId: string, configText: string): Promise<void> {
    await this.queue.add(
      `create:${name}:${randomUUID()}`, // 唯一 jobId（codex #1：不做去重槽位）
      { type: 'create', name, ownerId, configText },
      {
        removeOnComplete: true,
        // codex 三轮 P1：租约竞争（LeaseContentionError）须重试——attempts>1 + fixed backoff
        // （30s 起步，指数增长），覆盖 lease 5min 过期的重试窗口。最终失败（>10 次）落 failed
        // 集合，运维可经 list 感知 creating 行 + delete 清理。
        attempts: 10,
        backoff: { type: 'fixed', delay: 30_000 },
      },
    )
  }

  async enqueueDelete(name: string, ownerId: string, rowId: string): Promise<void> {
    await this.queue.add(
      `delete:${name}:${randomUUID()}`, // 唯一 jobId——delete 追着 pending create 也必入队
      { type: 'delete', name, ownerId, rowId },
      {
        removeOnComplete: true,
        attempts: 10,
        backoff: { type: 'fixed', delay: 30_000 },
      },
    )
  }

  async close(): Promise<void> {
    await this.queue.close()
  }
}

// 生产 worker：消费 openclaw-provision，按 job type 分发到编排器；同名 job 串行（PerNameChain）。
// stalled-job 由 BullMQ 默认恢复（maxStalledCount=1，lockDuration 默认 30s）。
// LeaseContentionError（codex 三轮 P1）：租约被另一 worker 持有 → 抛出让 BullMQ 按 backoff 重试，
// lease 过期后重试可抢占（不 no-op，否则 job 被移除、行永远 creating）。attempts=10 防无限重试。
export function createProvisioningWorker(orchestrator: Orchestrator): Worker<ProvisionJobData> {
  const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null })
  const chain = new PerNameChain()
  const worker = new Worker<ProvisionJobData>(
    QUEUE_NAME,
    async (job: Job<ProvisionJobData>) => {
      const data = job.data
      // 同名操作串行：create/delete 按 name 排队（异名并发，concurrency 兜底）
      await chain.run(data.name, async () => {
        if (data.type === 'create') {
          await orchestrator.provisionCreate(data.name, data.configText)
        } else {
          await orchestrator.provisionDelete(data.name, data.rowId)
        }
      })
    },
    {
      connection,
      concurrency: config.provisionWorkers,
      // 默认 attempts=1（失败即 failed，不重试）。LeaseContention 需重试——BullMQ 默认
      // backoff 策略：attempts>1 时 exponential（初始 30s 起步）。租约 5min 过期，重试窗口够。
      // 具体 attempts/backoff 由 enqueue 侧（BullMqProvisionQueue.add）设置，worker 只消费。
    },
  )
  worker.on('error', (err) => {
    // Redis 抖动 → 日志；BullMQ 自动重连（stalled-job 恢复兜底）
    // eslint-disable-next-line no-console
    console.error('[provision] worker error', err)
  })
  return worker
}
