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

  it('delayed mailbox wake survives worker restart with its complete command', async ctx => {
    if (!redisUp) ctx.skip()
    const queueName = `test-mail-wake-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    const ran: RunCommand[] = []
    const cmd: RunCommand = {
      runId: 'mail-timeout-test', sessionId: 'child-thread', parentSessionId: 'leader-thread',
      teammateId: 'worker', ownerId: 'u1', username: 'user1', kind: 'resume',
      mailWaitId: 'wait-id', mailWakeReason: 'timeout', mailBroadcastOnTimeout: true,
    }
    const first = new BullMqRunQueue({ redisUrl: REDIS_URL, queueName, execute: async command => { ran.push(command) } })
    try {
      await first.submit(cmd, { delayMs: 1000 })
    } finally { await first.close() }
    expect(ran).toEqual([])
    const restarted = new BullMqRunQueue({ redisUrl: REDIS_URL, queueName, execute: async command => { ran.push(command) } })
    queues.push(restarted)
    for (let i = 0; i < 150 && ran.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20))
    expect(ran).toEqual([cmd])
  }, 15_000)

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

// 超时兜底不依赖真 Redis：坏连接上 add 永挂（maxRetriesPerRequest:null 离线队列），submit
// 必须在 addTimeoutMs 内拒绝——timeout 兜底不得被等待 add settle 架空。
describe('BullMqRunQueue submit 超时兜底（坏 Redis，无门控）', () => {
  it('add 永挂 → submit 在 addTimeoutMs 内拒绝（不永挂）', async () => {
    const q = new BullMqRunQueue({
      redisUrl: 'redis://127.0.0.1:1/0', // 关闭端口——连接恒失败，add 永挂
      execute: async () => {},
      addTimeoutMs: 150,
    })
    const cmd: RunCommand = {
      runId: 'run-timeout',
      sessionId: 'sess-1',
      ownerId: 'u1',
      username: 'user1',
      kind: 'message',
      content: 'x',
    }
    const t0 = Date.now()
    await expect(q.submit(cmd)).rejects.toThrow('runner queue.add timeout')
    expect(Date.now() - t0).toBeLessThan(2000)
    await q.close()
  }, 10_000)
})
