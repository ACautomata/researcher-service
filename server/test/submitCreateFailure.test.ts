// submitCreate 失败补偿（Codex C8）。
// 路由层 `void orch.submitCreate(inst).catch(()=>{})` detach 后台 provisioning（C2）。
// 但生产 BullMQ 下若 queue.add() reject（Redis ACL / 只读 / 命令错误），runCreateComplete 从不执行 →
// createComplete 的 finally 不会释放 name lease → NameLeaseMap 永久持有 + 行卡 creating +
// recreate 被 InstanceExists(20041) 锁死。此测试验证 submitCreate 失败时释放 lease 并标 error。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { makeFleetTest, type FleetTestContext } from './fleetTestUtils'
import { seedUser } from './helpers'
import type { LifecycleQueue, LifecycleTask } from '../src/containers/lifecycleQueue'

// 「队列不可达」替身：submit 直接 reject，task 从不被调用（模拟 BullMQ queue.add 在 Redis
// ACL / 只读 / 命令错误下失败——task 注册后、worker 消费前）。
class FailingQueue implements LifecycleQueue {
  async submit(_task: LifecycleTask): Promise<void> {
    throw new Error('simulated queue.add reject (Redis ACL / read-only)')
  }
  async close(): Promise<void> {}
}

describe('submitCreate 失败补偿 (Codex C8)', () => {
  let ctx: TestContext
  let fl: FleetTestContext
  let ownerId: string

  beforeAll(async () => {
    ctx = await setupTestApp()
    fl = makeFleetTest(ctx.prisma, { queue: new FailingQueue() })
    const u = await seedUser(ctx.prisma, 'c8owner', 'pw-c8-secure')
    ownerId = u.id
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('队列不可达 → name lease 释放（修前永久持有，recreate 被 20041 锁死）', async () => {
    const inst = await fl.orch.createReserve('c8-lease', ownerId)
    expect(fl.deps.lock.isHeld('c8-lease')).toBe(true) // reserve 已取得 lease
    // 模拟路由层 detach：void + catch 吞错——正是 C8 触发条件
    await fl.orch.submitCreate(inst).catch(() => {})
    expect(fl.deps.lock.isHeld('c8-lease')).toBe(false)
  })

  it('队列不可达 → 行标 error（修前卡 creating，list 永久 pending）', async () => {
    const inst = await fl.orch.createReserve('c8-error', ownerId)
    await fl.orch.submitCreate(inst).catch(() => {})
    const row = await ctx.prisma.container.findUnique({ where: { name: 'c8-error' } })
    expect(row?.status).toBe('error')
  })
})
