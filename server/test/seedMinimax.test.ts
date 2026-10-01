// minimax 默认 provider seed 迁移测试（#775 · 731 §6）。
// 覆盖验收「minimax seed 迁移脚本幂等，重跑不产生重复行」：全量 seed 幂等（重跑零插入）、
// 已有显式配置 owner 跳过、(ownerId, providerId) 折叠纯函数（最早 createdAt 胜）、
// createUser 钩子（新建账号对齐「空 providers → 模板默认」现行为）。
// 经 setupTestApp 真 SQLite + REST 面（admin 建号）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import {
  MINIMAX_SEED_BASE_URL,
  MINIMAX_SEED_MODELS,
  MINIMAX_SEED_PROVIDER_ID,
  foldExtrasByOwnerProvider,
  seedMinimaxDefaultProviders,
  seedMinimaxForOwner,
} from '../src/models/seedMinimax'

describe('minimax seed 迁移（#775 · 731 §6）', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await setupTestApp()
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  async function providerRowsOf(ownerId: string) {
    return ctx.prisma.modelProvider.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' } })
  }

  it('全量 seed：每存量用户（零配置者）一行 minimax，字段对齐 openclaw.json 模板平移', async () => {
    const u1 = await seedUser(ctx.prisma, 'seedu1', 'pw-seedu1-secure')
    const u2 = await seedUser(ctx.prisma, 'seedu2', 'pw-seedu2-secure')
    const report = await seedMinimaxDefaultProviders(ctx.prisma)
    expect(report.seededOwnerIds).toEqual(expect.arrayContaining([u1.id, u2.id]))
    for (const u of [u1, u2]) {
      const rows = await providerRowsOf(u.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        ownerId: u.id,
        providerId: MINIMAX_SEED_PROVIDER_ID,
        baseUrl: MINIMAX_SEED_BASE_URL,
        lcProvider: 'anthropic', // api 'anthropic-messages' → lcProvider 映射（731 §2.1）
        credentialEnvId: 'LLM_API_KEY',
        authHeader: true,
      })
      expect(JSON.parse(rows[0].modelsJson)).toEqual(MINIMAX_SEED_MODELS)
    }
  })

  it('幂等：重跑零插入零重复行', async () => {
    const report1 = await seedMinimaxDefaultProviders(ctx.prisma)
    expect(report1.seededOwnerIds).toEqual([]) // 首轮测试已种满
    const rows1 = await ctx.prisma.modelProvider.findMany()
    const report2 = await seedMinimaxDefaultProviders(ctx.prisma)
    expect(report2.seededOwnerIds).toEqual([])
    expect(report2.foldedRows).toBe(0)
    const rows2 = await ctx.prisma.modelProvider.findMany()
    expect(rows2).toHaveLength(rows1.length) // 重跑不产生重复行（验收）
  })

  it('已有显式 provider 配置的 owner 跳过（不追加不改写）', async () => {
    const u = await seedUser(ctx.prisma, 'seedown', 'pw-seedown-secure')
    await ctx.prisma.modelProvider.create({
      data: {
        ownerId: u.id,
        providerId: 'my-openai',
        lcProvider: 'openai',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        credentialEnvId: 'LLM_API_KEY',
        authHeader: true,
        modelsJson: JSON.stringify([{ id: 'glm-4-plus' }]),
      },
    })
    const report = await seedMinimaxDefaultProviders(ctx.prisma)
    expect(report.seededOwnerIds).not.toContain(u.id)
    const rows = await providerRowsOf(u.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].providerId).toBe('my-openai')
  })

  it('foldExtrasByOwnerProvider（纯函数）：同 (ownerId, providerId) 冗余折叠，最早 createdAt 胜', () => {
    const t0 = new Date('2026-01-01T00:00:00Z')
    const rows = [
      { id: 'r1', ownerId: 'o1', providerId: 'minimax', createdAt: t0 },
      { id: 'r2', ownerId: 'o1', providerId: 'minimax', createdAt: new Date('2026-01-02T00:00:00Z') },
      { id: 'r3', ownerId: 'o1', providerId: 'minimax', createdAt: new Date('2026-01-02T00:00:00Z') }, // tie → id 升序保 r2
      { id: 'r4', ownerId: 'o2', providerId: 'my-openai', createdAt: new Date('2026-01-03T00:00:00Z') },
    ]
    const extras = foldExtrasByOwnerProvider(rows)
    expect(extras.map((r) => r.id)).toEqual(['r2', 'r3']) // o1 保最早 r1；o2 无冗余
  })

  it('seedMinimaxForOwner（原子面）：零配置插入 / 已配置跳过 / 并发撞 unique 幂等跳过', async () => {
    const u = await seedUser(ctx.prisma, 'seedatom', 'pw-seedatom-secure')
    expect(await seedMinimaxForOwner(ctx.prisma, u.id)).toBe(true)
    expect(await seedMinimaxForOwner(ctx.prisma, u.id)).toBe(false) // 已有配置 → false
    const rows = await providerRowsOf(u.id)
    expect(rows).toHaveLength(1)
  })

  it('createUser 钩子：REST 建号自动 seed minimax（对齐模板默认现行为）', async () => {
    await seedAdmin(ctx.prisma, 'seedadmin', 'pw-seedadmin-secure')
    const l = await login(ctx.request, 'seedadmin', 'pw-seedadmin-secure')
    const res = await ctx.request
      .post('/api/v1/users')
      .set(bearer(l.access))
      .send({ username: 'seednewuser', password: 'pw-seednewuser-secure' })
    expect(res.body.code).toBe(0)
    const created = await ctx.prisma.user.findUnique({ where: { username: 'seednewuser' } })
    expect(created).not.toBeNull()
    const rows = await providerRowsOf(created!.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].providerId).toBe(MINIMAX_SEED_PROVIDER_ID)
    expect(rows[0].baseUrl).toBe(MINIMAX_SEED_BASE_URL)
  })
})
