// Figures SVG 读/下载 S1 集成（#791 · #744 §4.2 新增端点）：
// GET /figures/:id/svg 返回 final SVG 文本（成功路径豁免信封）；?download=1 →
// Content-Disposition: attachment。覆盖：文本直发 + Content-Type / download 参数 /
// 70040 同码防探测 / svg 缺失 70043 / 未认证 10001。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, login, bearer } from './helpers'

const FIG_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'

async function seedFigure(ctx: TestContext, opts: { ownerId: string; svg?: string | null }) {
  return ctx.prisma.figure.create({
    data: {
      ownerId: opts.ownerId,
      prompt: 'chart',
      ...(opts.svg === undefined ? { svg: FIG_SVG } : { svg: opts.svg }),
    },
  })
}

describe('Figures SVG 读/下载 GET /figures/:id/svg', () => {
  let ctx: TestContext
  let userA: { id: string }
  let accessA: string
  let accessB: string
  let fig: { id: string }
  let figNoSvg: { id: string }

  beforeAll(async () => {
    ctx = await setupTestApp({})
    userA = await seedUser(ctx.prisma, 'svgA', 'pw-svga-secure')
    await seedUser(ctx.prisma, 'svgB', 'pw-svgb-secure')
    accessA = (await login(ctx.request, 'svgA', 'pw-svga-secure')).access!
    accessB = (await login(ctx.request, 'svgB', 'pw-svgb-secure')).access!
    fig = await seedFigure(ctx, { ownerId: userA.id })
    figNoSvg = await seedFigure(ctx, { ownerId: userA.id, svg: null }) // 数据完整性防御路径
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('owner 读取：SVG 文本直发（image/svg+xml，豁免信封不 base64）', async () => {
    const res = await ctx.request.get(`/api/v1/figures/${fig.id}/svg`).set(bearer(accessA))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/svg+xml; charset=utf-8')
    expect(Buffer.from(res.body).toString('utf8')).toBe(FIG_SVG)
  })

  it('?download=1 → Content-Disposition: attachment（浏览器不内联打开）', async () => {
    const res = await ctx.request.get(`/api/v1/figures/${fig.id}/svg?download=1`).set(bearer(accessA))
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toContain('attachment')
    expect(Buffer.from(res.body).toString('utf8')).toBe(FIG_SVG)
  })

  it('无 download 参数 → 无 Content-Disposition（内联消费形态）', async () => {
    const res = await ctx.request.get(`/api/v1/figures/${fig.id}/svg`).set(bearer(accessA))
    expect(res.headers['content-disposition']).toBeUndefined()
  })

  it('不存在 vs 越权同码 70040 防探测', async () => {
    const missing = await ctx.request.get('/api/v1/figures/no-such/svg').set(bearer(accessA))
    const forbidden = await ctx.request.get(`/api/v1/figures/${fig.id}/svg`).set(bearer(accessB))
    expect(missing.body.code).toBe(70040)
    expect(forbidden.body.code).toBe(70040)
    expect(missing.body.message).toBe(forbidden.body.message)
  })

  it('svg 缺失（数据完整性防御）→ 70043', async () => {
    const res = await ctx.request.get(`/api/v1/figures/${figNoSvg.id}/svg`).set(bearer(accessA))
    expect(res.body.code).toBe(70043)
  })

  it('未认证 → 10001', async () => {
    const res = await ctx.request.get(`/api/v1/figures/${fig.id}/svg`)
    expect(res.body.code).toBe(10001)
  })
})
