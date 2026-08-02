// BullMQ 生产队列联通测试（#313）：真 Redis 验证 BullMqLifecycleQueue submit→worker 消费→并发上限。
// 默认 skip 自动探测门控：Redis 不可达 → skip（CI 无 Redis 不阻塞）；可达 → 真跑。
// 区别于编排器单测的 InlineLifecycleQueue（inline 同步）——此处验证生产 BullMQ 接线本身。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { BullMqLifecycleQueue } from '../src/containers/bullmqQueue'

async function redisReachable(url: string): Promise<boolean> {
  try {
    const IORedis = (await import('ioredis')).default
    const r = new IORedis(url, { lazyConnect: true, connectTimeout: 1500 })
    await r.connect()
    await r.ping()
    r.disconnect()
    return true
  } catch {
    return false
  }
}

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/0'

// 探测挪进 beforeAll（tsconfig module=commonjs 不允许顶层 await，否则 tsc --noEmit 红线）。
describe('BullMqLifecycleQueue（真 Redis）', () => {
  let redisUp = false
  beforeAll(async () => {
    redisUp = await redisReachable(REDIS_URL)
  })

  const queues: BullMqLifecycleQueue[] = []
  afterAll(async () => {
    await Promise.all(queues.map((q) => q.close()))
  })

  it('submit → worker 消费执行（并发默认 2，stalled 重跑接线）', async (ctx) => {
    if (!redisUp) ctx.skip() // Redis 不可达 → skip（CI 无 Redis 不阻塞）
    const q = new BullMqLifecycleQueue({ redisUrl: REDIS_URL, concurrency: 2, queueName: `test-lifecycle-${process.pid}` })
    queues.push(q)
    await q.start()
    const ran: string[] = []
    // 提交 4 个任务，worker 并发 2 消费；全部完成后断言都执行了。
    await Promise.all([
      q.submit(async () => { ran.push('a') }),
      q.submit(async () => { ran.push('b') }),
      q.submit(async () => { ran.push('c') }),
      q.submit(async () => { ran.push('d') }),
    ])
    expect(ran.sort()).toEqual(['a', 'b', 'c', 'd'])
  }, 30_000)
})
