// Codex 第五轮 review（针对 e9e86b9）5 条意见的复现/回归测试。
// 覆盖：
// ①[P1] endpoint DELETE 的 submitDelete 不带 expectedId → 并发 DELETE 的 duplicate job
//       在 recreate 后误删新行/新容器（应对齐 reconcileRemoving 的代系绑定）
// ②[P2] dirRemover 失败 → 行留 removing 可重试
// ⑤[P2] buildItem 不查 instanceName label → 外来同名容器让 stale 行显示 running
// （原 ③ pairing join / ④ 探测并发上限随 T0 #801 pairing 全链与健康探针退役删除）

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { makeFleetTest } from './fleetTestUtils'
import { seedUser } from './helpers'

describe('codex round5: 意见①②⑤ 复现/回归', () => {
  let ctx: TestContext
  let ownerId: string

  beforeAll(async () => {
    ctx = await setupTestApp()
    const u = await seedUser(ctx.prisma, 'r5owner', 'pw-r5-secure')
    ownerId = u.id
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  // ---- ①[P1] endpoint DELETE 代系绑定 ----
  // 修前：deleteReserve 返回 'enqueued'，路由 submitDelete(name) 无 expectedId——两个并发 DELETE
  // 都通过归属检查后各入队一个 unversioned job。第一个 job 删掉旧行，用户 recreate 同名后，
  // 第二个 job 按 name 解析到新行 → 误删新容器/目录/数据（reconcileRemoving 的 requeue 已带
  // expectedId，endpoint 路径缺失——第五轮①要求 deleteReserve 返回行 ID 并透传）。
  it('① 并发 DELETE 的 duplicate job（携带旧行 ID）在 recreate 后 → 跳过清理', async () => {
    const fl1 = makeFleetTest(ctx.prisma)
    await fl1.orch.create('r5-epd', ownerId)
    const oldRow = await ctx.prisma.container.findUnique({ where: { name: 'r5-epd' } })
    expect(oldRow).not.toBeNull()
    // 第一个 job 完成全量清理（容器+目录+行）；用户 recreate 同名 → 新行 + 新容器。
    await fl1.orch.delete('r5-epd')
    await fl1.orch.create('r5-epd', ownerId)
    // 第二个（stale）job 经路由链执行——deleteReserve 返回 {id,status}（行 ID），路由把该 ID
    // 作为 expectedId 传给 submitDelete → 代系不匹配 → 跳过清理。等价验证：路由在第一个 DELETE
    // 时就捕获了旧行 ID（并发窗口在第一个 job 完成前），这里直接以旧行 ID 作为 expectedId。
    const reserve = await fl1.orch.deleteReserve('r5-epd') // 现返回行 ID（修前：'enqueued'）
    expect(reserve.id).toBeDefined()
    expect(reserve.status).toBe('removing')
    // 恢复新行状态（本用例只验证 stale job 语义，deleteReserve 的标 removing 已由既有测试覆盖）
    await ctx.prisma.container.update({ where: { name: 'r5-epd' }, data: { status: 'running' } })
    const outcome = await fl1.orch.submitDelete('r5-epd', oldRow!.id)
    expect(outcome).toBe('not-found')
    const row = await ctx.prisma.container.findUnique({ where: { name: 'r5-epd' } })
    expect(row?.status).toBe('running') // 新行保留（修前：被误删）
    expect(fl1.runtime.containers.has('r5-epd')).toBe(true) // 新容器保留
  })

  // ---- ②[P2] dirRemover 失败 → 行留 removing 可重试 ----
  // dirRemover 失败 throw InstanceCleanupError：容器已被确认 stop+remove，目录清理失败不吞——
  // 行留 removing（可重试），delete 本体不静默成功。（onEvict 逐出钩子随 T0 #801 chat pool 退役删除。）
  it('② dirRemover 失败（行留 removing 可重试）', async () => {
    const fl2 = makeFleetTest(ctx.prisma, { dirRemover: async () => { throw new Error('simulated dir cleanup failure') } })
    await fl2.orch.create('r5-evict', ownerId)
    await expect(fl2.orch.delete('r5-evict')).rejects.toThrow()
    // 容器已被 stop+remove（onEvict 前置前的事实）；行留 removing 可重试。
    expect(fl2.runtime.containers.has('r5-evict')).toBe(false)
    const row = await ctx.prisma.container.findUnique({ where: { name: 'r5-evict' } })
    expect(row?.status).toBe('removing')
  })



  // ---- ⑤[P2] buildItem 外来同名容器拒绝 ----
  // 修前：buildItem 只查 info.running，不校验 instanceName label——受管容器消失后，外部创建的
  // 同名容器（无 openclaw.instance label）让 stale 行被误报 running/healthy。修后：label 不匹配
  // → 视为 stopped（对齐 reconcileCreating/reconcileRemoving/delete 的所有权守卫）。
  it('⑤ 外来同名容器（label 不匹配）→ stale 行不报 running', async () => {
    const fl5 = makeFleetTest(ctx.prisma, )
    const inst = await fl5.orch.createReserve('r5-own', ownerId)
    await fl5.orch.createComplete(inst, true)
    // 受管容器消失（外部删除），外部创建同名容器：无 instance label（foreign）。
    const ownedSpec = fl5.runtime.containers.get('r5-own')!.spec
    fl5.runtime.containers.delete('r5-own')
    fl5.runtime.containers.set('r5-own', {
      info: {
        containerId: 'foreign-id',
        name: 'openclaw-gw-r5-own',
        running: true,
        status: 'running',
        image: 'some-image',
        instanceName: null, // 外来容器无本面板 label
      },
      spec: ownedSpec,
    })
    const items = await fl5.orch.list({ ownerId })
    const item = items.find((i) => i.name === 'r5-own')
    expect(item).toBeDefined()
    expect(item!.status).toBe('stopped') // 修前：running（+ 还额外发健康探测）
    expect(item!.health).toBe('stopped')
  })
})
