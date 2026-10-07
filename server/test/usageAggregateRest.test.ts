// usage aggregate admin REST 测试（接缝 #2 信封级，#800 admin 核算页数据源）：
// 认证/admin 门（10001/10004）· 按 user × provider × model 聚合（aggregateUsage 接线）·
// userId 过滤 · 时间窗 [from, to) 半开区间 · wire snake_case 对齐 auditRoutes 契约。
//
// 采数面（recordLlmUsage/extractUsageMetadata）已由 #775 测试锁定，本文件只测 REST 接线面。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'

describe('usage aggregate admin REST（#800）', () => {
  let ctx: TestContext
  const base = '/api/v1/usage/aggregate'
  const userSeed = { username: 'usageuser', password: 'pw-usageuser-secure' }
  const adminSeed = { username: 'usageadmin', password: 'pw-usageadmin-secure' }
  let userId: string

  beforeAll(async () => {
    ctx = await setupTestApp()
    const u = await seedUser(ctx.prisma, userSeed.username, userSeed.password)
    userId = u.id
    await seedAdmin(ctx.prisma, adminSeed.username, adminSeed.password)
    // 两行同 user 同模型（聚合成一行，calls=2）+ 一行异模型（单独一行）
    const mk = (model: string, input: number, output: number) => ({
      runId: `run-${model}`,
      sessionId: null,
      userId,
      username: userSeed.username,
      providerId: 'p1',
      lcProvider: 'openai',
      model,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    await ctx.prisma.llmUsageRecord.createMany({
      data: [mk('m1', 100, 50), mk('m1', 200, 80), mk('m2', 10, 5)],
    })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('未认证 → 10001', async () => {
    const res = await ctx.request.get(base)
    expect(res.body.code).toBe(10001)
  })

  it('非 admin → 10004', async () => {
    const l = await login(ctx.request, userSeed.username, userSeed.password)
    const res = await ctx.request.get(base).set(bearer(l.access))
    expect(res.body.code).toBe(10004)
  })

  it('admin GET 全量 → 按 user×provider×model 聚合，wire snake_case', async () => {
    const l = await login(ctx.request, adminSeed.username, adminSeed.password)
    const res = await ctx.request.get(base).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    const items = res.body.data.items as Record<string, unknown>[]
    expect(items).toHaveLength(2)
    const m1 = items.find((i) => i.model === 'm1')!
    expect(m1).toMatchObject({
      user_id: userId,
      username: userSeed.username,
      provider_id: 'p1',
      lc_provider: 'openai',
      calls: 2,
      input_tokens: 300,
      output_tokens: 130,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    })
    expect(items.find((i) => i.model === 'm2')).toMatchObject({ calls: 1, input_tokens: 10 })
  })

  it('userId 过滤 → 只含该用户聚合行', async () => {
    const l = await login(ctx.request, adminSeed.username, adminSeed.password)
    const res = await ctx.request
      .get(`${base}?userId=${userId}`)
      .set(bearer(l.access))
    expect(res.body.data.items).toHaveLength(2)
    const miss = await ctx.request.get(`${base}?userId=nope`).set(bearer(l.access))
    expect(miss.body.data.items).toHaveLength(0)
  })

  it('时间窗 [from,to) 半开：边界行不双计', async () => {
    const l = await login(ctx.request, adminSeed.username, adminSeed.password)
    const rows = await ctx.prisma.llmUsageRecord.findMany({ orderBy: { createdAt: 'asc' } })
    const t1 = rows[0].createdAt.toISOString()
    const res = await ctx.request
      .get(`${base}?from=${encodeURIComponent(t1)}&to=${encodeURIComponent(t1)}`)
      .set(bearer(l.access))
    expect(res.body.data.items).toHaveLength(0)
  })
})
