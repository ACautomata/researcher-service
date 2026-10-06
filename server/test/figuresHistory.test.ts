// Figures 读面 S1 集成（#791 · #744 v2 §5/§8 换轨后形状）：
// GenerationJob 退役 → Figure 行 = 成功产物聚合（无状态列）；REST 创建端点退役（工具是唯一
// 生成入口），读面常驻（无 flag 门——插件禁用后历史资产仍可读，#744 §11.3）。
// 覆盖：仅自己列表 / 他人不出现 / createdAt DESC + id tiebreaker / 投影形状（figureId/prompt/
// sessionId/createdAt）/ 本人详情 previewReady / 不存在与越权同码 70040 / admin 跨用户 /
// 无删除与创建端点（写面收缩验证）/ 未认证 10001 / 路由常驻（不传 figures deps 亦可读）。
// 接缝：REST 信封接缝（setupTestApp + seedUser/seedAdmin + login + bearer）+ 持久化 fixture
//（直接种子 Figure 行，不依赖生成链——fixture 是测试技术，不是依赖边）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, seedAdmin, login, bearer } from './helpers'

// fixture：直接布置 Figure 行（新形状：svg/png/sessionId 可选）。
async function seedFigure(
  ctx: TestContext,
  opts: {
    ownerId: string
    prompt?: string
    id?: string
    createdAt?: Date
    svg?: string | null
    sessionId?: string | null
  },
) {
  return ctx.prisma.figure.create({
    data: {
      id: opts.id,
      ownerId: opts.ownerId,
      prompt: opts.prompt ?? 'chart',
      svg: opts.svg === undefined ? '<svg xmlns="http://www.w3.org/2000/svg"></svg>' : opts.svg,
      sessionId: opts.sessionId ?? null,
      createdAt: opts.createdAt,
    },
  })
}

describe('Figures 读面 GET /figures —— 普通用户列表（仅自己 · 排序 · 空列表）', () => {
  let ctx: TestContext
  let userA: { id: string }
  let userB: { id: string }
  let accessA: string

  beforeAll(async () => {
    ctx = await setupTestApp({}) // 读面常驻：无 figures deps 注入即挂载（flag 门退役）
    userA = await seedUser(ctx.prisma, 'histA', 'pw-hista-secure')
    userB = await seedUser(ctx.prisma, 'histB', 'pw-histb-secure')
    accessA = (await login(ctx.request, 'histA', 'pw-hista-secure')).access!
    // 用户 A：老 / 中 / 新三条；用户 B：一条（绝不应出现在 A 列表）
    await seedFigure(ctx, { ownerId: userA.id, prompt: 'oldest', createdAt: new Date('2026-01-01T00:00:00Z') })
    await seedFigure(ctx, { ownerId: userB.id, prompt: 'other-user', createdAt: new Date('2026-01-02T00:00:00Z') })
    await seedFigure(ctx, { ownerId: userA.id, prompt: 'middle', createdAt: new Date('2026-01-03T00:00:00Z') })
    await seedFigure(ctx, { ownerId: userA.id, prompt: 'newest', createdAt: new Date('2026-01-04T00:00:00Z') })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('只返回自己的 Figure，他人 Figure 不出现；createdAt DESC（最新在前）', async () => {
    const res = await ctx.request.get('/api/v1/figures').set(bearer(accessA))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    const data = res.body.data
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(3) // B 的一条不出现
    expect(data.map((x: { prompt: string }) => x.prompt)).toEqual(['newest', 'middle', 'oldest'])
    // 列表项精确形状：仅 figureId/prompt/sessionId/createdAt，无状态/jobId 等退役字段
    for (const item of data) {
      expect(item).toEqual({
        figureId: expect.any(String),
        prompt: expect.any(String),
        sessionId: null,
        createdAt: expect.any(String),
      })
    }
  })

  it('createdAt 撞车 → id DESC 稳定 tiebreaker（确定性二级序，不暴露排序选项）', async () => {
    await seedFigure(ctx, { ownerId: userA.id, id: 'zzz-tie-a', prompt: 'tie-a', createdAt: new Date('2026-01-05T00:00:00Z') })
    await seedFigure(ctx, { ownerId: userA.id, id: 'aaa-tie-b', prompt: 'tie-b', createdAt: new Date('2026-01-05T00:00:00Z') })
    const res = await ctx.request.get('/api/v1/figures').set(bearer(accessA))
    const data = res.body.data
    // 同日两条内部按 id DESC：zzz-tie-a 在 aaa-tie-b 之前
    expect(data.filter((x: { prompt: string }) => x.prompt.startsWith('tie-')).map((x: { prompt: string }) => x.prompt)).toEqual([
      'tie-a',
      'tie-b',
    ])
  })

  it('无数据用户 → code 0 + 空数组 []', async () => {
    await seedUser(ctx.prisma, 'histC', 'pw-histc-secure')
    const accessC = (await login(ctx.request, 'histC', 'pw-histc-secure')).access!
    const res = await ctx.request.get('/api/v1/figures').set(bearer(accessC))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ code: 0, message: expect.any(String), data: [] })
  })

  it('列表投影不含产物大列（svg/png/evaluation 不出现在任何项）', async () => {
    await seedFigure(ctx, { ownerId: userA.id, prompt: 'with-svg' })
    const res = await ctx.request.get('/api/v1/figures').set(bearer(accessA))
    for (const item of res.body.data) {
      expect(item.svg).toBeUndefined()
      expect(item.png).toBeUndefined()
      expect(item.evaluation).toBeUndefined()
    }
  })
})

describe('Figures 读面 GET /figures/:id —— 详情 / 归属门 / admin', () => {
  let ctx: TestContext
  let userA: { id: string }
  let accessA: string
  let accessB: string
  let accessAdmin: string
  let figA: { id: string }

  beforeAll(async () => {
    ctx = await setupTestApp({})
    userA = await seedUser(ctx.prisma, 'detA', 'pw-deta-secure')
    await seedUser(ctx.prisma, 'detB', 'pw-detb-secure')
    await seedAdmin(ctx.prisma, 'detadmin', 'pw-detadmin-secure')
    accessA = (await login(ctx.request, 'detA', 'pw-deta-secure')).access!
    accessB = (await login(ctx.request, 'detB', 'pw-detb-secure')).access!
    accessAdmin = (await login(ctx.request, 'detadmin', 'pw-detadmin-secure')).access!
    figA = await seedFigure(ctx, {
      ownerId: userA.id,
      prompt: 'network topology',
      sessionId: 'sess-xyz',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
    })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('本人详情：figureId/prompt/sessionId/createdAt + previewReady（png 缺省 false）+ updatedAt', async () => {
    const res = await ctx.request.get(`/api/v1/figures/${figA.id}`).set(bearer(accessA))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({
      figureId: figA.id,
      prompt: 'network topology',
      sessionId: 'sess-xyz',
      createdAt: expect.any(String),
      previewReady: false,
      updatedAt: expect.any(String),
    })
  })

  it('不存在 vs 越权同码 70040 防探测（响应逐字节一致）', async () => {
    const missing = await ctx.request.get('/api/v1/figures/no-such-id').set(bearer(accessA))
    const forbidden = await ctx.request.get(`/api/v1/figures/${figA.id}`).set(bearer(accessB))
    expect(missing.status).toBe(200)
    expect(forbidden.status).toBe(200)
    expect(missing.body.code).toBe(70040)
    expect(forbidden.body.code).toBe(70040)
    // 「不存在 vs 越权」对外不可区分：除 message 外的信封结构一致（message 均为 70040 文案）
    expect(missing.body.message).toBe(forbidden.body.message)
    expect(missing.body.data).toBe(forbidden.body.data)
  })

  it('admin 跨用户可见（越权门放行 admin）', async () => {
    const res = await ctx.request.get(`/api/v1/figures/${figA.id}`).set(bearer(accessAdmin))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.figureId).toBe(figA.id)
  })

  it('admin 列表 = 所有用户的 Figure', async () => {
    const res = await ctx.request.get('/api/v1/figures').set(bearer(accessAdmin))
    const prompts = res.body.data.map((x: { prompt: string }) => x.prompt)
    expect(prompts).toContain('network topology')
  })
})

describe('Figures 读面 —— 写面收缩（创建/删除端点退役）', () => {
  let ctx: TestContext
  let access: string

  beforeAll(async () => {
    ctx = await setupTestApp({})
    await seedUser(ctx.prisma, 'shrink', 'pw-shrink-secure')
    access = (await login(ctx.request, 'shrink', 'pw-shrink-secure')).access!
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('POST /figures 已退役（REST 创建端点不在——工具是唯一生成入口，#744 Q10）', async () => {
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .set('Idempotency-Key', 'k'.repeat(32))
      .send({ prompt: 'x' })
    expect(res.status).toBe(200) // #312 信封纪律：错误信号在 body
    expect(res.body.code).toBe(90005) // ROUTE_NOT_FOUND（创建端点退役 → 路由不存在）
  })

  it('未认证 → 10001（requireAuth 门）', async () => {
    const res = await ctx.request.get('/api/v1/figures')
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(10001)
  })
})
