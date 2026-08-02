// reconcileRemoving 对账（Codex C6）。
// 进程重启后 BullMQ worker 的 tasks map 丢失，stalled/queued job 经 processor 时 if(!task) return
// 被 BullMQ 当成功移除，但 lifecycle 操作未执行 → delete 中断的行卡 removing 永不收敛
// （reconcileCreating 只处理 creating，removing 行直接透传无对账）。此测试验证 list 读路径对账 removing 行。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { setupTestApp, type TestContext } from './setup'
import { makeFleetTest, type FleetTestContext } from './fleetTestUtils'
import { seedUser } from './helpers'
import { FleetReadModel } from '../src/containers/readModel'

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
    // 第七轮 #5 后：「无容器分支」经 requeueDelete detach 走 delete 本体（代系 recheck 仲裁），
    // 行删除异步收敛（不再在读路径同步 dirRemover+删行）——轮询等行消失。
    let row = await ctx.prisma.container.findUnique({ where: { name: 'c6-gone' } })
    for (let i = 0; i < 400 && row; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      row = await ctx.prisma.container.findUnique({ where: { name: 'c6-gone' } })
    }
    expect(row).toBeNull()
  })

  it('removing 行 + runtime 仍驻留容器 → 重新入队 delete 清理（修前残留孤儿容器 + 行卡 removing）', async () => {
    // 先正常建容器（runtime 容器 + DB 行 + instanceDir 都齐）
    await fl.orch.create('c6-stuck', ownerId)
    expect(fl.runtime.containers.has('c6-stuck')).toBe(true)
    // 模拟 delete worker 静默 return：手动标 removing，容器 / 目录仍在（清理未跑）
    await ctx.prisma.container.update({ where: { name: 'c6-stuck' }, data: { status: 'removing' } })
    // list 触发对账 → 重新入队 delete（Codex 第三轮 ① 后 requeue 只入队不 await：list 不阻塞在
    // 删除完成上，立即返回 removing 状态；delete 经队列异步随后执行）。
    await fl.orch.list({ ownerId })
    // list 返回后 delete 已入队（异步 detach）——轮询等待行删除完成（delete 全链：停删容器 →
    // 清目录 → 删行；行消失才算完成。窗口 2s 防并行负载偶发慢）。
    let row = await ctx.prisma.container.findUnique({ where: { name: 'c6-stuck' } })
    for (let i = 0; i < 400 && row; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      row = await ctx.prisma.container.findUnique({ where: { name: 'c6-stuck' } })
    }
    expect(row).toBeNull()
    expect(fl.runtime.containers.has('c6-stuck')).toBe(false)
  })

  // ---- requeue 代系绑定（Codex 第四轮①[P1]）----
  // reconcileRemoving 对「removing 行 + runtime 容器仍驻留」每轮 list 都 detach 一个 submitDelete，
  // 无去重 → 多个 duplicate job 在 BullMQ 排队。第一个 job 删掉旧行后，用户 recreate 同名，后续 stale
  // job 到达时 FleetCommand.delete() 用 name（而非行 ID）解析目标 → 误删新行/新容器。
  // 修法：requeue 携带旧行 ID（expectedId），delete 执行时校验代系，不匹配则跳过清理。

  it('requeueDelete 携带被观察行 ID（供 delete 校验代系）', async () => {
    const fl1 = makeFleetTest(ctx.prisma)
    await fl1.orch.create('r4-gen', ownerId)
    const oldRow = await ctx.prisma.container.findUnique({ where: { name: 'r4-gen' } })
    expect(oldRow).not.toBeNull()
    await ctx.prisma.container.update({ where: { name: 'r4-gen' }, data: { status: 'removing' } })
    // 注入捕获回调：list 触发 requeue 时应携带旧行 ID（不自动执行，模拟 job 排队）。
    const requeued: Array<{ name: string; rowId?: string }> = []
    const read = new FleetReadModel(fl1.deps, ctx.prisma, async (name, rowId) => {
      requeued.push({ name, rowId })
    })
    await read.list({ ownerId })
    expect(requeued.length).toBe(1)
    expect(requeued[0].name).toBe('r4-gen')
    expect(requeued[0].rowId).toBe(oldRow!.id) // 携带旧行 ID，供 delete 校验代系
  })

  it('stale delete（携带旧行 ID）在 recreate 后执行 → 跳过清理、不误删新行', async () => {
    const fl1 = makeFleetTest(ctx.prisma)
    await fl1.orch.create('r4-stale', ownerId)
    const oldRow = await ctx.prisma.container.findUnique({ where: { name: 'r4-stale' } })
    expect(oldRow).not.toBeNull()
    // 模拟：第一个 duplicate job 已完成全量清理（容器+目录+行）；用户 recreate 同名 → 新行 + 新容器。
    await fl1.orch.delete('r4-stale')
    await fl1.orch.create('r4-stale', ownerId)
    // stale job 携带旧行 ID 执行 → 代系不匹配 → 跳过清理，返回 not-found。
    const outcome = await fl1.orch.submitDelete('r4-stale', oldRow!.id)
    expect(outcome).toBe('not-found')
    // 新行 + 新容器保留（修前：新行被删 + 新容器被 stop/remove）。
    const row = await ctx.prisma.container.findUnique({ where: { name: 'r4-stale' } })
    expect(row?.status).toBe('running')
    expect(fl1.runtime.containers.has('r4-stale')).toBe(true)
  })
})

// ---- #5 reconcileRemoving「无容器分支」代系竞态（Codex 第七轮 P1）----
// reconcileRemoving 处理 removing 行 R1：runtime.get 返回 null（容器已不在）→「无容器分支」
// 直接 dirRemover(instanceDir) + prisma.delete(R1)，缺 delete 本体（command.ts:522）那样的
// current.id !== inst.id 代系 recheck。若 dirRemover（rm -rf 慢遍历）期间旧行被并发 delete
// 收尾删除、用户同名 recreate 建新代系 R2 并写入新 home 数据，则此处的 rm 会删掉 R2 的新数据。
//
// JS 单线程无法跨请求并发，但 reconcileRemoving 在 `await runtime.get` 处 yield——spy 挂起 get，
// 在挂起期间主线程换新代系（删 R1 + 建 R2 + 写 R2 数据），放行后 reconcileRemoving 持有的仍是 R1
// 快照（id=oldId），而 dirRemover 落到已属 R2 的目录。修前直接 rm 误删 R2；修后 route through
// requeueDelete(name, oldId)，delete 本体 findUnique=R2(newId)≠oldId → 跳过清理 → R2 数据存活。
describe('#5 reconcileRemoving 无容器分支代系竞态 (Codex 第七轮 P1)', () => {
  let ctx: TestContext
  let ownerId: string

  beforeAll(async () => {
    ctx = await setupTestApp()
    const u = await seedUser(ctx.prisma, 'r7owner', 'pw-r7-secure')
    ownerId = u.id
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('行已换新代系时跳过 dirRemover（修前误删新代系 home 数据）', async () => {
    const fl = makeFleetTest(ctx.prisma)
    const name = 'race-x'
    const instanceDir = path.join(fl.fleetRoot, 'instances', name)
    const homeDir = path.join(instanceDir, 'home')

    // R1：removing 行 + 已 provision 的 instanceDir/home（含旧数据）。
    await mkdir(homeDir, { recursive: true })
    await writeFile(path.join(homeDir, 'R1.marker'), 'old-gen')
    const r1 = await ctx.prisma.container.create({
      data: {
        name,
        port: 19003,
        token: 'enc1',
        tokenEncrypted: true,
        homeDir,
        containerId: 'r1-cid',
        status: 'removing',
        image: fl.config.image,
        ownerId,
      },
    })

    // 门控 runtime.get：reconcileRemoving 在 await get(name) 处挂起，期间测试换新代系。
    let releaseGet!: () => void
    let getReached = false
    const gate = new Promise<void>((r) => {
      releaseGet = r
    })
    const getSpy = vi.spyOn(fl.runtime, 'get').mockImplementation(async (n) => {
      if (n === name) {
        getReached = true
        await gate
        return null // 容器已不在 → 进「无容器分支」
      }
      return null
    })

    // 触发 list（读路径对账）。orch.read 已注入 requeueDelete = cmd.submitDelete（代系绑定）。
    const listP = fl.orch.list({ ownerId })
    // 等 reconcileRemoving 进入 runtime.get（getReached）。
    for (let i = 0; i < 200 && !getReached; i += 1) {
      await new Promise((r) => setTimeout(r, 1))
    }
    expect(getReached).toBe(true)

    // 换新代系：删 R1 行 + 同名建 R2（新 id）+ 写新 home 数据（模拟 createComplete 的 mkdir+provision）。
    await ctx.prisma.container.delete({ where: { id: r1.id } })
    await ctx.prisma.container.create({
      data: {
        name,
        port: 19005,
        token: 'enc2',
        tokenEncrypted: true,
        homeDir,
        containerId: 'r2-cid',
        status: 'running',
        image: fl.config.image,
        ownerId,
      },
    })
    await writeFile(path.join(homeDir, 'R2.marker'), 'new-gen')

    // 放行 get → reconcileRemoving 继续：进「无容器分支」，持有的快照仍是 R1（id=r1.id）。
    releaseGet()
    await listP

    getSpy.mockRestore()

    // 断言：R2 的新 home 数据须存活。修前 reconcileRemoving 直接 dirRemover(instanceDir)
    // → rm -rf 删掉 R2.marker（误删新代系）；修后 requeueDelete(name, r1.id) → delete 本体
    // findUnique=name 得 R2(newId)≠r1.id → 跳过清理 → R2.marker 存活。
    expect(existsSync(path.join(homeDir, 'R2.marker'))).toBe(true)
    // 新代系行保留。
    const row = await ctx.prisma.container.findUnique({ where: { name } })
    expect(row?.containerId).toBe('r2-cid')
  })
})
