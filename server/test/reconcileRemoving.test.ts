// reconcileRemoving 对账（Codex C6）。
// 进程重启后 BullMQ worker 的 tasks map 丢失，stalled/queued job 经 processor 时 if(!task) return
// 被 BullMQ 当成功移除，但 lifecycle 操作未执行 → delete 中断的行卡 removing 永不收敛
// （reconcileCreating 只处理 creating，removing 行直接透传无对账）。此测试验证 list 读路径对账 removing 行。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { makeFleetTest, type FleetTestContext } from './fleetTestUtils'
import { seedUser } from './helpers'

describe('reconcileRemoving 对账 (Codex C6)', () => {
  let ctx: TestContext
  let fl: FleetTestContext
  let ownerId: string

  beforeAll(async () => {
    ctx = await setupTestApp()
    fl = makeFleetTest(ctx.prisma)
    const u = await seedUser(ctx.prisma, 'c6owner', 'pw-c6-secure')
    ownerId = u.id
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('removing 行 + runtime 无容器 → list 删行收敛（修前永卡 removing）', async () => {
    // 模拟 delete worker 静默 return 后的残留：stop/remove 已删容器，但删行没跑到（行留 removing）。
    await ctx.prisma.container.create({
      data: {
        name: 'c6-gone',
        port: 19001,
        token: 'enc',
        tokenEncrypted: true,
        homeDir: `${fl.fleetRoot}/instances/c6-gone/home`,
        containerId: 'gone-id',
        status: 'removing',
        image: fl.config.image,
        ownerId,
      },
    })
    // runtime 无该容器（FakeRuntime 默认空）—— lock 未持有（无活动 create）
    await fl.orch.list({ ownerId })
    expect(await ctx.prisma.container.findUnique({ where: { name: 'c6-gone' } })).toBeNull()
  })

  it('removing 行 + runtime 仍驻留容器 → 重新入队 delete 清理（修前残留孤儿容器 + 行卡 removing）', async () => {
    // 先正常建容器（runtime 容器 + DB 行 + instanceDir 都齐）
    await fl.orch.create('c6-stuck', ownerId)
    expect(fl.runtime.containers.has('c6-stuck')).toBe(true)
    // 模拟 delete worker 静默 return：手动标 removing，容器 / 目录仍在（清理未跑）
    await ctx.prisma.container.update({ where: { name: 'c6-stuck' }, data: { status: 'removing' } })
    // list 触发对账 → 重新入队 delete → 清理容器 + 删行（InlineLifecycleQueue 同步跑完）
    await fl.orch.list({ ownerId })
    expect(fl.runtime.containers.has('c6-stuck')).toBe(false)
    expect(await ctx.prisma.container.findUnique({ where: { name: 'c6-stuck' } })).toBeNull()
  })
})
