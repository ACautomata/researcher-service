// BullMqRunQueue 联通测试（#777）：真 Redis 验证 submit → worker 消费 → 自包含 data 重跑语义。
// 默认 skip 自动探测门控（Redis 不可达 → skip；先例 bullmqQueue.test.ts）。
// 同 thread 串行不在队列层（RunService 串行链责任，见 runnerRunService.test.ts）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { BullMqRunQueue } from '../src/runner/bullmqRunQueue'
import type { RunCommand } from '../src/runner/runtime/runService'

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

describe('BullMqRunQueue（真 Redis）', () => {
  let redisUp = false
  beforeAll(async () => {
    redisUp = await redisReachable(REDIS_URL)
  })

  const queues: BullMqRunQueue[] = []
  afterAll(async () => {
    await Promise.all(queues.map((q) => q.close()))
  })

  function makeQueue(execute: (cmd: RunCommand) => Promise<void>): BullMqRunQueue {
    const q = new BullMqRunQueue({
      redisUrl: REDIS_URL,
      execute,
      concurrency: 4,
      queueName: `test-runner-runs-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      addTimeoutMs: 2000,
    })
    queues.push(q)
    return q
  }

  it('submit → worker 消费执行（自包含 RunCommand data）', async (ctx) => {
    if (!redisUp) ctx.skip()
    const ran: RunCommand[] = []
    const q = makeQueue(async (cmd) => {
      ran.push(cmd)
    })
    const cmd: RunCommand = {
      runId: `run-${Math.random().toString(36).slice(2, 10)}`,
      sessionId: 'sess-1',
      ownerId: 'u1',
      username: 'user1',
      kind: 'message',
      content: 'hello',
    }
    await q.submit(cmd)
    for (let i = 0; i < 100 && ran.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(ran).toHaveLength(1)
    expect(ran[0]).toMatchObject({ runId: cmd.runId, sessionId: 'sess-1', kind: 'message' })
  }, 15_000)

  it('并发 submit 多命令全部消费（顺序性归 RunService 串行链，此处只验证不丢）', async (ctx) => {
    if (!redisUp) ctx.skip()
    const ran = new Set<string>()
    const q = makeQueue(async (cmd) => {
      ran.add(cmd.runId)
    })
    const ids = Array.from({ length: 5 }, () => `run-${Math.random().toString(36).slice(2, 10)}`)
    await Promise.all(
      ids.map((runId) =>
        q.submit({
          runId,
          sessionId: 'sess-1',
          ownerId: 'u1',
          username: 'user1',
          kind: 'message',
          content: 'x',
        }),
      ),
    )
    for (let i = 0; i < 150 && ran.size < 5; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(ran.size).toBe(5)
  }, 20_000)
})
