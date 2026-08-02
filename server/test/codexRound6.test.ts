// Codex 第六轮 review（针对 c3f8f20）5 条 P2 意见的复现/回归测试。
// 覆盖：
// ① finalizeFailedCreate 回滚按 name force-remove 不校验 instance label → 误删外部同名容器
// ② bind 冲突重试换端口时 update(port) 撞 P2002 不重试 → 中止、行卡 creating
// （第 ③/④/⑤ 条分别在 bullmqQueueSubmitLeak.test.ts / containers.test.ts / config.test.ts）

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { makeFleetTest } from './fleetTestUtils'
import { seedUser } from './helpers'

describe('codex round6: 意见①② 复现/回归', () => {
  let ctx: TestContext
  let ownerId: string

  beforeAll(async () => {
    ctx = await setupTestApp()
    const u = await seedUser(ctx.prisma, 'r6owner', 'pw-r6-secure')
    ownerId = u.id
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  // ---- ①[P2] finalizeFailedCreate 回滚须校验 ownership ----
  // 修前：run 撞外部同名容器（慢 pull 期间另一 Docker actor 抢先建 openclaw-gw-<name>、抛非 bind 的
  // 名冲突）→ finalizeFailedCreate 的 get(name) 返回外部容器 → 按名 force-remove 误删外部容器，
  // 并把外部 containerId 冒领进本行。应对齐 delete 的 instanceName 所有权守卫：仅挂本行 label 才 remove。
  it('① run 撞外部同名容器（instance label 不符）→ 回滚不误删外部容器、不冒领 id', async () => {
    const fl = makeFleetTest(ctx.prisma)
    // preexisting 检查时无容器；run 期间植入外部容器（instanceName 故意 ≠ 'foreign'）并抛名冲突。
    fl.runtime.plantExternalFor.set('foreign', 'some-other-instance')
    const inst = await fl.orch.createReserve('foreign', ownerId)
    await expect(fl.orch.createComplete(inst, true)).rejects.toThrow()
    // 外部容器存活（修前被 force-remove 删掉）：
    const ext = fl.runtime.containers.get('foreign')?.info
    expect(ext?.containerId).toBe('external-foreign')
    expect(ext?.instanceName).toBe('some-other-instance')
    // 行保留 ERROR（可 list+delete 感知），未冒领外部 id：
    const row = await ctx.prisma.container.findUnique({ where: { name: 'foreign' } })
    expect(row?.status).toBe('error')
    expect(row?.containerId).toBe('')
  })

  // ---- ②[P2] bind 重试换端口 update 撞 P2002 须重试 ----
  // 修前：bind 冲突重试时 prisma.container.update({data:{port}}) 撞 P2002（并发不同名 create 抢注同一
  // 替换端口，port @unique）不重试、直接中止 → 行卡 creating 直到后续 list 对账。应对齐 reserveRow
  // 把 P2002 视作 learned conflict、重选下一候选端口。
  it('② bind 重试 update(port) 撞 P2002 → 视作 learned conflict 换下一候选（修前中止、行卡 creating）', async () => {
    // 独立端口池（19600–19610），避免与本文件 ① 的 'foreign' 行耦合；fresh 池 → reserved = 池最小值。
    const fl = makeFleetTest(ctx.prisma, { config: { portStart: 19600, portEnd: 19610 } })
    const inst = await fl.orch.createReserve('p2002', ownerId)
    fl.runtime.bindConflictPorts.add(inst.port) // reserved 端口 bind 冲突 → 触发换端口重试
    // fresh 池下 nextFree 首个替换候选 = reserved + 1；注入该端口的 update 撞 P2002（DB 唯一冲突，非 bind）。
    const conflictPort = inst.port + 1
    const origUpdate = ctx.prisma.container.update.bind(ctx.prisma.container)
    ctx.prisma.container.update = (async (args: Parameters<typeof origUpdate>[0]) => {
      // data 是 Prisma 联合更新类型，窄化读 port；命中注入端口即抛 P2002（DB 唯一冲突，非 bind）。
      const port = (args.data as { port?: number } | undefined)?.port
      if (port === conflictPort) throw { code: 'P2002' }
      return origUpdate(args)
    }) as never
    try {
      await fl.orch.createComplete(inst, true) // 修前 P2002 中止抛错；修后换 reserved+2 成功
    } finally {
      ctx.prisma.container.update = origUpdate
    }
    const row = await ctx.prisma.container.findUnique({ where: { name: 'p2002' } })
    expect(row?.status).toBe('running')
    expect(row?.port).toBe(inst.port + 2) // 跳过 P2002 的 reserved+1，落到 reserved+2
    expect(fl.runtime.containers.get('p2002')?.spec.hostPort).toBe(inst.port + 2)
  })
})
