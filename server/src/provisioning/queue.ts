import { Queue, Worker, type ConnectionOptions } from 'bullmq'
import IORedis from 'ioredis'
import { config } from '../config'
import type { Orchestrator, ProvisionJobQueue } from '../orchestrator/orchestrator'

// BullMQ provisioning 队列（#334 M2 · #313 并发模型）。
// Redis-backed；worker 并发可配默认 2；stalled-job 崩溃重跑（BullMQ 默认）。
// create/delete 同队列同 jobId(name) → 按 name 入队串行（消竞态，k8s Terminating 式）。

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
}

export type ProvisionJobData = CreateJobData | DeleteJobData

// 真实 BullMQ 队列适配（生产装配；测试注入内存 fake 不触 Redis）。
export class BullMqProvisionQueue implements ProvisionJobQueue {
  private readonly queue: Queue<ProvisionJobData>

  constructor(connection: ConnectionOptions) {
    this.queue = new Queue<ProvisionJobData>(QUEUE_NAME, { connection })
  }

  async enqueueCreate(name: string, ownerId: string, configText: string): Promise<void> {
    // jobId=name：#313 按 name 入队串行——同名 create/delete 共用同一 job 槽，
    // 活跃/等待中同名 job 不会被重复 enqueue（BullMQ 拒绝重复 jobId）。
    await this.queue.add(
      name,
      { type: 'create', name, ownerId, configText },
      { jobId: name, removeOnComplete: true },
    )
  }

  async enqueueDelete(name: string, ownerId: string): Promise<void> {
    await this.queue.add(
      name,
      { type: 'delete', name, ownerId },
      { jobId: name, removeOnComplete: true },
    )
  }

  async close(): Promise<void> {
    await this.queue.close()
  }
}

// 生产 worker：消费 openclaw-provision，按 job type 分发到编排器。stalled-job 由 BullMQ 默认恢复。
export function createProvisioningWorker(orchestrator: Orchestrator): Worker<ProvisionJobData> {
  const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null })
  const worker = new Worker<ProvisionJobData>(
    QUEUE_NAME,
    async (job) => {
      const data = job.data
      if (data.type === 'create') {
        await orchestrator.provisionCreate(data.name, data.configText)
      } else {
        await orchestrator.provisionDelete(data.name)
      }
    },
    { connection, concurrency: config.provisionWorkers },
  )
  worker.on('error', (err) => {
    // Redis 抖动 → 日志；BullMQ 自动重连（stalled-job 恢复兜底）
    // eslint-disable-next-line no-console
    console.error('[provision] worker error', err)
  })
  return worker
}
