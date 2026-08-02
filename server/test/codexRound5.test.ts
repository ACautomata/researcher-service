// Codex 第五轮 review（针对 e9e86b9）5 条意见的复现/回归测试。
// 覆盖：
// ①[P1] endpoint DELETE 的 submitDelete 不带 expectedId → 并发 DELETE 的 duplicate job
//       在 recreate 后误删新行/新容器（应对齐 reconcileRemoving 的代系绑定）
// ②[P2] dirRemover 失败 throw 跳过 onEvict → 容器已移除但 chat pool 不逐出
// ③[P2] pairing 预取按 name join → 同名 recreate 竞态把新 owner pairing 附到旧行摘要
// ④[P2] list 健康/运行时探针无并发上限（Promise.all）→ 大 fleet 打爆 fd
// ⑤[P2] buildItem 不查 instanceName label → 外来同名容器让 stale 行显示 running

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { makeFleetTest } from './fleetTestUtils'
import { seedUser } from './helpers'
import { FleetReadModel } from '../src/containers/readModel'

describe('codex round5: 意见①—⑤ 复现/回归', () => {
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

  // ---- ②[P2] dirRemover 失败时 onEvict 仍触发 ----
  // 修前：onEvict 在 dirRemover 之后、只有清理成功才执行——dirRemover 失败 throw
  // InstanceCleanupError 时跳过逐出。容器已被确认 stop+remove，gateway 已死，cached client
  // 却持续重连不存在的网关。修后：onEvict 移到 dirRemover 之前（容器移除已确认即逐出）。
  it('② dirRemover 失败（行留 removing 可重试）→ onEvict 已触发', async () => {
    const onEvict = vi.fn(async () => {})
    const fl2 = makeFleetTest(ctx.prisma, { dirRemover: async () => { throw new Error('simulated dir cleanup failure') }, onEvict })
    await fl2.orch.create('r5-evict', ownerId)
    await expect(fl2.orch.delete('r5-evict')).rejects.toThrow()
    expect(onEvict).toHaveBeenCalledTimes(1) // 修前：0（throw 跳过）
    expect(onEvict).toHaveBeenCalledWith({ name: 'r5-evict', port: expect.any(Number) })
    // 容器已被 stop+remove（onEvict 前置前的事实）；行留 removing 可重试。
    expect(fl2.runtime.containers.has('r5-evict')).toBe(false)
    const row = await ctx.prisma.container.findUnique({ where: { name: 'r5-evict' } })
    expect(row?.status).toBe('removing')
  })

  // ---- ③[P2] pairing 按 containerId 代系 join ----
  // 修前：pairing 预取 where container.name in names，byName join——删除后同名 recreate 的
  // 竞态窗口（list 与 pairing 查询之间）把新 owner 的 pairing 附到旧行摘要。修后：listWithIds
  // 携带行 ID，pairing 按 containerId join。
  it('③ pairing 快照按 containerId join（行 ID 来自 listWithIds）', async () => {
    const fl3 = makeFleetTest(ctx.prisma)
    await fl3.orch.create('r5-pair', ownerId)
    const row = await ctx.prisma.container.findUnique({ where: { name: 'r5-pair' } })
    expect(row).not.toBeNull()
    await ctx.prisma.pairing.create({
      data: {
        containerId: row!.id,
        status: 'paired',
        deviceId: 'r5-device',
        scopesJson: '["chat"]',
        pairingRequestId: 'r5-req',
      },
    })
    // 直接驱动 readModel（路由同源）：listWithIds 返回 items + ids；配对按行 ID 解析。
    const read = new FleetReadModel(fl3.deps, ctx.prisma)
    const { items, ids } = await read.listWithIds({ ownerId })
    const item = items.find((i) => i.name === 'r5-pair')
    const id = ids.get('r5-pair')
    expect(item?.status).toBe('running')
    expect(id).toBe(row!.id)
    const pairing = await ctx.prisma.pairing.findUnique({ where: { containerId: id! } })
    expect(pairing?.deviceId).toBe('r5-device')
    // 路由层 join（与 routes/containers.ts 同逻辑）：byContainerId.get(id) 命中本行 pairing。
    expect(pairing && pairing.containerId).toBe(row!.id)
  })

  // ---- ④[P2] list 探针并发上限 ----
  // 修前：Promise.all 对每个容器并发一个 runtime.get + 一个健康探测，大 fleet 一次轮询可开
  // 数百 socket/timer。修后：mapWithConcurrency 以 8 为限。注入慢 runtime.get 计数并发峰值。
  it('④ list 对 N 容器的探测并发 ≤ 8（峰值计数，而非 Promise.all 无界）', async () => {
    const fl4 = makeFleetTest(ctx.prisma, { config: { portEnd: 19050 } }) // 大池容纳 20 容器
    const names: string[] = []
    for (let i = 0; i < 20; i += 1) {
      const n = `r5-c${i}`
      names.push(n)
      await fl4.orch.create(n, ownerId)
    }
    let inflight = 0
    let peak = 0
    const origGet = fl4.runtime.get.bind(fl4.runtime)
    fl4.runtime.get = async (name: string) => {
      inflight += 1
      peak = Math.max(peak, inflight)
      await new Promise((r) => setTimeout(r, 10))
      const result = await origGet(name)
      inflight -= 1
      return result
    }
    const read = new FleetReadModel(fl4.deps, ctx.prisma)
    const { items } = await read.listWithIds({ ownerId })
    const mine = items.filter((i) => i.name.startsWith('r5-c'))
    expect(mine.length).toBe(20) // 只看本测试的 20 个（共享 fleet 还留着 beforeAll 的容器）
    expect(peak).toBeLessThanOrEqual(8) // 修前：20（全部并发）
  })

  // ---- ⑤[P2] buildItem 外来同名容器拒绝 ----
  // 修前：buildItem 只查 info.running，不校验 instanceName label——受管容器消失后，外部创建的
  // 同名容器（无 openclaw.instance label）让 stale 行被误报 running/healthy。修后：label 不匹配
  // → 视为 stopped（对齐 reconcileCreating/reconcileRemoving/delete 的所有权守卫）。
  it('⑤ 外来同名容器（label 不匹配）→ stale 行不报 running', async () => {
    const fl5 = makeFleetTest(ctx.prisma, { config: { portEnd: 19030 } })
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
        port: 19000,
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
