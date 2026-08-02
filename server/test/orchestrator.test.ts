// 编排器 Port 测试（接缝 #5）：注入假 docker + 内存假队列，断言
// 5 态机 + 取消标志 + 端口入队前分配 + 补偿（bind 换端口重试 / REMOVING 可重试 / 端口耗尽 / 残留目录）。
// 覆盖 issue #334 验收标准的编排层（非 HTTP 壳）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { setupTestApp, type TestContext } from './setup'
import { makeFleetTest, type FleetTestContext } from './fleetTestUtils'
import { seedUser } from './helpers'
import {
  InstanceExists,
  InstanceDirExists,
  InstanceCleanupError,
  PortAllocationError,
  ConfigurationError,
  QuotaExceeded,
} from '../src/containers/errors'
import { HOME_BIND } from '../src/containers/constants'

describe('orchestrator (接缝 #5 编排器 Port)', () => {
  let ctx: TestContext
  let fl: FleetTestContext
  let ownerId: string

  beforeAll(async () => {
    ctx = await setupTestApp()
    fl = makeFleetTest(ctx.prisma)
    const u = await seedUser(ctx.prisma, 'owner1', 'pw-owner1-secure')
    ownerId = u.id
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  // ---- 端口入队前分配 + 5 态机 creating→running ----
  it('create 同步预占返 creating 快照（端口已分配），complete 后 running', async () => {
    const inst = await fl.orch.createReserve('web-one', ownerId)
    // 端口入队前分配：reserve 即带 port（池最小空闲 19000），status=creating
    expect(inst.status).toBe('creating')
    expect(inst.port).toBe(19000)
    expect(inst.containerId).toBe('')
    // home 路径固化 instances/<name>/home；token 已生成不落盘
    expect(inst.homeDir).toContain(path.join('instances', 'web-one', 'home'))
    expect(inst.token.length).toBeGreaterThan(0)

    await fl.orch.createComplete(inst, true)
    const row = await ctx.prisma.container.findUnique({ where: { name: 'web-one' } })
    expect(row?.status).toBe('running')
    expect(row?.containerId).not.toBe('')
    // runtime 已起容器，bind-mount home + config(ro) + 端口映射 + label 所有权
    const rec = fl.runtime.containers.get('web-one')
    expect(rec?.spec.hostPort).toBe(19000)
    expect(rec?.info.instanceName).toBe('web-one')
    // config 已原子落盘 + 安全不变量（port 18789 / bind lan / token 占位）
    const cfgText = require('node:fs').readFileSync(
      path.join(fl.fleetRoot, 'instances', 'web-one', 'openclaw.json'),
      'utf8',
    )
    const cfg = JSON.parse(cfgText)
    expect(cfg.gateway.port).toBe(18789)
    expect(cfg.gateway.bind).toBe('lan')
    expect(cfg.gateway.auth.token).toBe('${GATEWAY_TOKEN}')
  })

  it('LLM key 缺失 → ConfigurationError（90003），不占端口不建行', async () => {
    const fl2 = makeFleetTest(ctx.prisma, { config: { llmApiKey: '' } })
    await expect(fl2.orch.createReserve('nokey', ownerId)).rejects.toBeInstanceOf(ConfigurationError)
    expect(await ctx.prisma.container.findUnique({ where: { name: 'nokey' } })).toBeNull()
  })

  it('同名并发 create：租约互斥快速失败 20041，无双创建', async () => {
    const first = await fl.orch.createReserve('dup', ownerId)
    // 同名第二次 reserve（租约在飞）→ InstanceExists
    await expect(fl.orch.createReserve('dup', ownerId)).rejects.toBeInstanceOf(InstanceExists)
    await fl.orch.createComplete(first, true)
    // DB 仍只有一行 dup
    expect(await ctx.prisma.container.count({ where: { name: 'dup' } })).toBe(1)
    // 完成后租约释放，再次同名撞 DB 唯一约束 → InstanceExists（20041）
    await expect(fl.orch.createReserve('dup', ownerId)).rejects.toBeInstanceOf(InstanceExists)
  })

  it('撞名 20041 不分占用者：他人占用 name，我也撞', async () => {
    const other = await seedUser(ctx.prisma, 'other1', 'pw-other1-secure')
    await fl.orch.create('taken', other.id)
    await expect(fl.orch.createReserve('taken', ownerId)).rejects.toBeInstanceOf(InstanceExists)
  })

  it('残留 orphan 目录（DB 无行）→ InstanceDirExists（20044）', async () => {
    // 手工造残留目录（DB 无行）
    mkdirSync(path.join(fl.fleetRoot, 'instances', 'orphan'), { recursive: true })
    await expect(fl.orch.createReserve('orphan', ownerId)).rejects.toBeInstanceOf(InstanceDirExists)
    // reserve 失败已回滚 creating 行
    expect(await ctx.prisma.container.findUnique({ where: { name: 'orphan' } })).toBeNull()
  })

  it('bind 端口冲突就地换端口重试：最终 running，端口前移', async () => {
    // 19000 已被前面容器占用；注入 19001 也 bind 冲突 → 应跳到 19002
    fl.runtime.bindConflictPorts.add(19001)
    const inst = await fl.orch.createReserve('bindy', ownerId)
    const reservedPort = inst.port // 入队前分配的端口（19001，因 19000 已占）
    fl.runtime.bindConflictPorts.add(reservedPort)
    await fl.orch.createComplete(inst, true)
    const row = await ctx.prisma.container.findUnique({ where: { name: 'bindy' } })
    expect(row?.status).toBe('running')
    expect(row?.port).not.toBe(reservedPort) // 已就地换端口
    expect(fl.runtime.containers.get('bindy')?.spec.hostPort).toBe(row?.port)
  })

  it('非 bind 失败：后台保留 ERROR 行（preserveErrorRow），可 list+delete 感知', async () => {
    fl.runtime.failRunFor.add('broken')
    const inst = await fl.orch.createReserve('broken', ownerId)
    await expect(fl.orch.createComplete(inst, true)).rejects.toThrow()
    const row = await ctx.prisma.container.findUnique({ where: { name: 'broken' } })
    expect(row?.status).toBe('error') // ERROR 行保留，不静默消失
    // 目录已回滚清理
    expect(existsSync(path.join(fl.fleetRoot, 'instances', 'broken'))).toBe(false)
  })

  it('端口池耗尽 → PortAllocationError（90004）', async () => {
    // 极小池（2 候选），全部 bind 冲突 → 重试预算（=池大小）耗尽
    const flSmall = makeFleetTest(ctx.prisma, {
      config: { portStart: 19500, portEnd: 19501 },
    })
    flSmall.runtime.bindConflictPorts.add(19500).add(19501)
    const inst = await flSmall.orch.createReserve('exhaust', ownerId)
    await expect(flSmall.orch.createComplete(inst, true)).rejects.toBeInstanceOf(PortAllocationError)
  })

  it('取消标志：delete 在飞 create，检查点检出即统一回滚后终止', async () => {
    // create 入队但未 complete；delete 置取消标志 → complete 检出即回滚（不跑 docker run）
    const inst = await fl.orch.createReserve('cancelme', ownerId)
    await fl.orch.deleteReserve('cancelme') // 置取消标志 + 标 removing
    // complete 在首个检查点检出取消 → finalizeFailedCreate（preserveErrorRow=true 标 error）
    await expect(fl.orch.createComplete(inst, true)).rejects.toThrow()
    // 未跑 docker run（取消于 run 前检查点）
    expect(fl.runtime.containers.has('cancelme')).toBe(false)
  })

  it('delete 完整生命周期：stop+remove 容器、清目录、删行、触发 evict', async () => {
    const evicted: { name: string; port: number }[] = []
    const fl3 = makeFleetTest(ctx.prisma, {
      onEvict: async (i) => {
        evicted.push(i)
      },
    })
    await fl3.orch.create('delme', ownerId)
    const created = await ctx.prisma.container.findUnique({ where: { name: 'delme' } })
    expect(created).not.toBeNull()
    await fl3.orch.delete('delme')
    expect(await ctx.prisma.container.findUnique({ where: { name: 'delme' } })).toBeNull()
    expect(fl3.runtime.containers.has('delme')).toBe(false)
    expect(existsSync(path.join(fl3.fleetRoot, 'instances', 'delme'))).toBe(false)
    // chown 已被调用（root 容器 home 清理前置）
    expect(fl3.runtime.execCalls.some((c) => c.cmd[0] === 'chown' && c.cmd.includes(HOME_BIND))).toBe(true)
    // evict 钩子已触发（携带删除前的 name/port 供逐出）
    expect(evicted).toEqual([{ name: 'delme', port: created!.port }])
  })

  it('delete 清理失败：行标 REMOVING 可重试（20045）', async () => {
    const fl4 = makeFleetTest(ctx.prisma, {
      dirRemover: async () => {
        throw new Error('permission denied')
      },
    })
    await fl4.orch.create('stuck', ownerId)
    await expect(fl4.orch.delete('stuck')).rejects.toBeInstanceOf(InstanceCleanupError)
    const row = await ctx.prisma.container.findUnique({ where: { name: 'stuck' } })
    expect(row?.status).toBe('removing') // 行保留标 REMOVING
    // 容器已停删（重试只清目录 + 删行）
    expect(fl4.runtime.containers.has('stuck')).toBe(false)
  })

  it('同名 delete 排在在飞 create 后（按 name 串行）；recreate 清取消标志不误中止', async () => {
    // 覆盖 #334「同名并发 create/delete 串行化」：delete 经 submitDelete 入队，排在同 name
    // 在飞 create 之后执行——create 先完整 provisioning 成 running，delete 再接手清理。
    const inst = await fl.orch.createReserve('serialize-me', ownerId)
    await fl.orch.deleteReserve('serialize-me') // 置取消标志 + 标 removing
    const createPromise = fl.orch.submitCreate(inst) // 入队 create（inline 队列）
    const deletePromise = fl.orch.submitDelete('serialize-me') // 同 name → 排在 create 后
    const [, outcome] = await Promise.all([createPromise, deletePromise])
    // create 先跑完（cancel 标志已 flag 时 createComplete 检查点检出回滚、不跑 docker run），
    // delete 随后删行——最终无行、无容器、无目录。
    expect(outcome).toBe('removed')
    expect(await ctx.prisma.container.findUnique({ where: { name: 'serialize-me' } })).toBeNull()
    expect(fl.runtime.containers.has('serialize-me')).toBe(false)
    expect(existsSync(path.join(fl.fleetRoot, 'instances', 'serialize-me'))).toBe(false)
    // recreate（P2-5）：createReserve 入口清残留取消标志，同名重建不被误中止。
    await fl.orch.create('serialize-me', ownerId)
    expect((await ctx.prisma.container.findUnique({ where: { name: 'serialize-me' } }))?.status).toBe(
      'running',
    )
    expect(fl.runtime.containers.has('serialize-me')).toBe(true)
  })

  it('list 隔离：user 仅自己、admin 全部；running/stopped 由 runtime 实况推导', async () => {
    const a = await seedUser(ctx.prisma, 'lista', 'pw-lista-secure')
    const b = await seedUser(ctx.prisma, 'listb', 'pw-listb-secure')
    await fl.orch.create('a-box', a.id)
    await fl.orch.create('b-box', b.id)
    const ownList = await fl.orch.list({ ownerId: a.id })
    expect(ownList.map((i) => i.name)).toEqual(['a-box'])
    const all = await fl.orch.list({})
    expect(all.map((i) => i.name)).toEqual(expect.arrayContaining(['a-box', 'b-box']))
    // running（runtime 实况）+ health（health probe true → healthy）
    const aItem = all.find((i) => i.name === 'a-box')!
    expect(aItem.status).toBe('running')
    expect(aItem.health).toBe('healthy')
    // stop 后 list 推导 stopped
    await fl.runtime.stop('a-box')
    const stopped = (await fl.orch.list({})).find((i) => i.name === 'a-box')!
    expect(stopped.status).toBe('stopped')
    expect(stopped.health).toBe('stopped')
  })

  it('gateway token 加密落盘：DB 存密文、createComplete 解密供 spec 明文（Codex C1）', async () => {
    const inst = await fl.orch.createReserve('crypto-box', ownerId)
    // reserve 即落盘密文：tokenEncrypted=true，token 以 v1: 前缀（非明文）
    const reserved = await ctx.prisma.container.findUnique({ where: { name: 'crypto-box' } })
    expect(reserved?.tokenEncrypted).toBe(true)
    expect(reserved?.token.startsWith('v1:')).toBe(true)
    await fl.orch.createComplete(inst, true)
    // runtime 收到的 spec.gatewayToken 是解密后的明文（docker env 注入真 token，非 DB 密文）
    const rec = fl.runtime.containers.get('crypto-box')
    expect(rec?.spec.gatewayToken).toBeTruthy()
    expect(rec?.spec.gatewayToken.startsWith('v1:')).toBe(false)
    // 落盘密文 ≠ 注入明文（真值不落盘，AGENTS.md §5.2）
    const row = await ctx.prisma.container.findUnique({ where: { name: 'crypto-box' } })
    expect(row?.token).not.toBe(rec?.spec.gatewayToken)
  })

  it('配额 check-then-act 收紧：并发不同名 create 同 owner 不绕过配额（Codex C4）', async () => {
    // 独立 fl + 独立端口区间：隔离前面累积的 DB 行占端口，让配额逻辑成为唯一变量。
    const qfl = makeFleetTest(ctx.prisma, { config: { portStart: 19400, portEnd: 19410 } })
    const qOwner = await seedUser(ctx.prisma, 'qowner', 'pw-qowner-secure')
    // maxContainers=1 + 并发两个不同名 create：按 owner 串行化后恰一个成功、一个 QuotaExceeded，
    // 不双双绕过 count 双创建超配额（修复前 routes 层 count→create 的 check-then-act 让两者都过 count）。
    const results = await Promise.allSettled([
      qfl.orch.createReserve('q-a', qOwner.id, 1),
      qfl.orch.createReserve('q-b', qOwner.id, 1),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(QuotaExceeded)
    // DB 仅 1 行属该 owner（不超配额）
    expect(await ctx.prisma.container.count({ where: { ownerId: qOwner.id } })).toBe(1)
  })
})
