// Codex 第三轮 review（针对 9550045）7 条意见的复现/回归测试。
// 覆盖：
// ①[P1] readModel.requeueDelete 在 list 中 await → 轮询被删除完成阻塞（应只入队不等待）
// ②[P1] command.delete 空 containerId 跳过容器清理 → 崩溃后 run 成功但 ID 未存 → 容器泄露
// ③[P1] finalizeFailedCreate remove 失败仍删目录 → 活容器数据被删
// ④[P1] createReserve cancel.clear 过早 → 并发 retry 清掉在飞 create 的取消标志
// ⑤[P2] reconcileRemoving 无容器分支直接删行 → instances/<name> orphan 遗留
// ⑥[P2] createReserve renderer 失败不删行 → creating 行残留耗配额/占端口

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setupTestApp, type TestContext } from './setup'
import { makeFleetTest, type FleetTestContext } from './fleetTestUtils'
import { seedUser } from './helpers'
import { InstanceExists } from '../src/containers/errors'

describe('codex round3: 意见①—⑥ 复现/回归', () => {
  let ctx: TestContext
  let fl: FleetTestContext
  let ownerId: string

  beforeAll(async () => {
    ctx = await setupTestApp()
    fl = makeFleetTest(ctx.prisma)
    const u = await seedUser(ctx.prisma, 'r3owner', 'pw-r3-secure')
    ownerId = u.id
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  // ---- ①[P1] requeueDelete 阻塞 list ----
  // 修前：requeueDelete?.() 是 async 回调（await submitDelete，经 BullMQ 排在在飞 delete 后），
  // list 在 reconcileRemoving 中 await 它 → 轮询阻塞在被观察的删除上（Redis 不可达更糟，永挂）。
  // 修后：只入队不等待，list 立即返回 removing 状态。
  it('① 无租约 removing 行 + 容器驻留 → list 不被 requeue 阻塞', async () => {
    const fl1 = makeFleetTest(ctx.prisma)
    await fl1.orch.create('r3-req', ownerId)
    await ctx.prisma.container.update({
      where: { name: 'r3-req' },
      data: { status: 'removing' },
    })
    // 直接驱动 FleetReadModel，注入「永不 settle」的 requeueDelete 替身：
    // 若 list 内部 await 它 → Promise.race 超时返回 null（修前）；若只入队不 await → 立即返回（修后）。
    const hung = new Promise<void>(() => {}) // 永不 resolve
    const { FleetReadModel } = await import('../src/containers/readModel')
    const read = new FleetReadModel(fl1.deps, ctx.prisma, () => hung)
    const items = await Promise.race([
      read.list({ ownerId }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
    ])
    expect(items).not.toBeNull() // list 不被 requeue 阻塞
    const req = items!.find((i) => i.name === 'r3-req')
    expect(req?.status).toBe('removing') // 仍显示 removing，待 delete 收敛
  })

  // ---- ②[P1] 空 containerId 删除跳过容器清理 ----
  // 崩溃窗口：runtime.run() 已起容器，但进程在「prisma.update 存 containerId」前崩溃 → 行 creating +
  // containerId=''。直接 DELETE（无 GET 对账）→ 现 delete() 因 containerId 为空跳过 stop/remove，
  // 直接清目录+删行 → docker 容器泄露。
  it('② 空 containerId 的 creating 行 DELETE → 容器被清理（不留孤儿容器）', async () => {
    const fl2 = makeFleetTest(ctx.prisma)
    const inst = await fl2.orch.createReserve('r3-crash', ownerId)
    await fl2.orch.createComplete(inst, true) // 正常建（容器 + 目录 + 行 running）
    expect(fl2.runtime.containers.has('r3-crash')).toBe(true)
    // 回退到崩溃后状态：行 status=creating、containerId=''（模拟 run 已成功但 update 未存 ID）。
    await ctx.prisma.container.update({
      where: { name: 'r3-crash' },
      data: { status: 'creating', containerId: '' },
    })
    await fl2.orch.delete('r3-crash') // 直接 delete（不经 list 对账）
    // 修后：容器被 stop+remove（不留孤儿）
    expect(fl2.runtime.containers.has('r3-crash')).toBe(false)
    expect(await ctx.prisma.container.findUnique({ where: { name: 'r3-crash' } })).toBeNull()
  })

  // ---- ③[P1] remove 失败仍删目录 ----
  // run 成功但后续 prisma.update 失败（行消失/P2025）→ finalizeFailedCreate；其清容器 catch 吞掉
  // remove 失败后仍执行 dirRemover → 容器可能仍在跑、其 bind-mount home 数据被删。
  it('③ run 后 remove 失败 → 保留实例目录 + 容器（不清活容器数据）', async () => {
    const fl3 = makeFleetTest(ctx.prisma)
    fl3.runtime.remove = async (name: string) => {
      if (name === 'r3-keepp') throw new Error('simulated daemon failure on remove')
    }
    const inst = await fl3.orch.createReserve('r3-keepp', ownerId)
    // 模拟行在 createComplete 中途消失（崩溃/并发 delete）：后续 prisma.update 抛 P2025 → 失败收尾。
    await ctx.prisma.container.delete({ where: { id: inst.id } })
    await expect(fl3.orch.createComplete(inst, true)).rejects.toThrow()
    // 修后：remove 无法确认 → 目录保留（数据未删）、容器仍驻留（未删）
    const dir = path.join(fl3.fleetRoot, 'instances', 'r3-keepp')
    expect(existsSync(dir)).toBe(true)
    expect(fl3.runtime.containers.has('r3-keepp')).toBe(true)
  })

  // ---- ④[P1] cancel.clear 过早 ----
  // 并发 retry POST：createReserve 入口 cancel.clear(name) 在 tryAcquire 前——在飞 create 仍持租约时，
  // retry 先清掉取消标志再因租约持有抛 InstanceExists → 原 create 错过取消检查点、继续跑 docker run。
  it('④ 在飞 create 持有租约时并发 retry → 不清取消标志（原 create 仍可被取消）', async () => {
    const inst = await fl.orch.createReserve('r3-cancel', ownerId) // 取得租约（在飞 create）
    await fl.orch.deleteReserve('r3-cancel') // 置取消标志
    // 并发 retry：同 name → 租约仍被持 → 应抛 InstanceExists，且**不得清除**取消标志。
    await expect(fl.orch.createReserve('r3-cancel', ownerId)).rejects.toBeInstanceOf(InstanceExists)
    // 原 create complete → 若取消标志被清（修前）会继续 run；未清（修后）在检查点回滚、不跑 run。
    await expect(fl.orch.createComplete(inst, true)).rejects.toThrow()
    expect(fl.runtime.containers.has('r3-cancel')).toBe(false) // 未跑 docker run
  })

  // ---- ⑤[P2] reconcileRemoving 无容器分支删行不删目录 ----
  it('⑤ removing 行 + 无容器 + 遗留目录 → 对账清目录（不留 orphan 阻止 recreate）', async () => {
    const fl5 = makeFleetTest(ctx.prisma)
    const inst = await fl5.orch.createReserve('r3-orphan', ownerId)
    await fl5.orch.createComplete(inst, true) // 落目录 + 容器
    // 模拟 delete 已停删容器但清目录前崩溃：remove 容器、行标 removing、目录保留。
    await fl5.runtime.remove('r3-orphan')
    await ctx.prisma.container.update({
      where: { name: 'r3-orphan' },
      data: { status: 'removing' },
    })
    const dir = path.join(fl5.fleetRoot, 'instances', 'r3-orphan')
    expect(existsSync(dir)).toBe(true)
    await fl5.orch.list({ ownerId }) // list 触发对账
    // 修后：目录被清 + 行被删
    expect(existsSync(dir)).toBe(false)
    expect(await ctx.prisma.container.findUnique({ where: { name: 'r3-orphan' } })).toBeNull()
    // recreate 不再被 orphan 目录拒绝
    await fl5.orch.create('r3-orphan', ownerId)
    expect(fl5.runtime.containers.has('r3-orphan')).toBe(true)
  })

  // ---- ⑥[P2] createReserve renderer 失败不删行 ----
  it('⑥ 模板损坏（renderer 构造失败）→ reserve 的行被回滚（不耗配额/占端口）', async () => {
    const badJson = path.join(fl.fleetRoot, 'bad.json')
    writeFileSync(badJson, 'not json') // JSON.parse 抛 SyntaxError
    const fl6 = makeFleetTest(ctx.prisma, { config: { templateJson: badJson } })
    // renderer 失败可能抛 SyntaxError（JSON 坏）/ ConfigurationError（shape 坏）/ readFile 错（缺失）；
    // 核心断言是「失败后行被回滚」——用 toThrow() 不锁具体类型。
    await expect(fl6.orch.createReserve('r3-badcfg', ownerId)).rejects.toThrow()
    // 修后：creating 行被回滚删除（配额/端口/名称释放）——坏模板下 recreate 仍会失败，
    // 但「失败不再消耗 quota/端口/名称」已由行删除保证（修前 creating 行残留、recreate 撞 20041）。
    expect(await ctx.prisma.container.findUnique({ where: { name: 'r3-badcfg' } })).toBeNull()
    // 行删除后，租约/端口/配额已释放：再次尝试仍是「配置错误」而非「撞名 20041」——
    // 用 20041（InstanceExists）作对照：修前第二次 createReserve 会撞 20041（行残留），
    // 修后不会（行已删）——抛的是模板解析错误而非 InstanceExists。
    await expect(fl6.orch.createReserve('r3-badcfg', ownerId)).rejects.not.toBeInstanceOf(
      InstanceExists,
    )
    // 换好模板后同名可立即重建（不 20041 / 不 20044）
    const flGood = makeFleetTest(ctx.prisma)
    const inst = await flGood.orch.createReserve('r3-badcfg', ownerId)
    expect(inst.status).toBe('creating')
    await flGood.orch.createComplete(inst, true).catch(() => {})
  })
})
