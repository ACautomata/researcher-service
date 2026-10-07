// Codex 第六轮 review（针对 c3f8f20）5 条 P2 意见的复现/回归测试。
// 覆盖：
// ① finalizeFailedCreate 回滚按 name force-remove 不校验 instance label → 误删外部同名容器
// （原 ② bind 冲突换端口用例随 T0 #801 端口池退役删除；第 ③/④/⑤ 条分别在
// bullmqQueueSubmitLeak.test.ts / containers.test.ts / config.test.ts）

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { makeFleetTest } from './fleetTestUtils'
import { seedUser } from './helpers'

describe('codex round6: 意见① 复现/回归', () => {
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

})
