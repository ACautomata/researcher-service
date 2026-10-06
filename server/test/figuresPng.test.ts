// Figures PNG 下载 S1 集成（#791 · #744 v2 §5 换轨后形状）：
// GenerationJob 退役 → 无进行态（70042 不可达）；Figure 行恒为成功产物，png 缺省
//（渲染失败不致命）→ 70043。覆盖：owner 下载原生字节 / 70040 同码防探测 / admin 放行 /
// png null → 70043 / 未认证 10001。SVG 下载端点见 figuresSvg.test.ts。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, seedAdmin, login, bearer } from './helpers'

// 1x1 红色 PNG（合法 PNG 签名字节，供成功路径断言字节直发）
const TINY_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

async function seedFigure(
  ctx: TestContext,
  opts: { ownerId: string; png?: Uint8Array<ArrayBuffer> | null },
) {
  return ctx.prisma.figure.create({
    data: {
      ownerId: opts.ownerId,
      prompt: 'chart',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      ...(opts.png === undefined ? { png: TINY_PNG } : { png: opts.png }),
    },
  })
}

describe('Figures PNG 下载 GET /figures/:id/png', () => {
  let ctx: TestContext
  let userA: { id: string }
  let accessA: string
  let accessB: string
  let accessAdmin: string
  let figWithPng: { id: string }
  let figNoPng: { id: string }

  beforeAll(async () => {
    ctx = await setupTestApp({})
    userA = await seedUser(ctx.prisma, 'pngA', 'pw-pnga-secure')
    await seedUser(ctx.prisma, 'pngB', 'pw-pngb-secure')
    await seedAdmin(ctx.prisma, 'pngadmin', 'pw-pngadmin-secure')
    accessA = (await login(ctx.request, 'pngA', 'pw-pnga-secure')).access!
    accessB = (await login(ctx.request, 'pngB', 'pw-pngb-secure')).access!
    accessAdmin = (await login(ctx.request, 'pngadmin', 'pw-pngadmin-secure')).access!
    figWithPng = await seedFigure(ctx, { ownerId: userA.id })
    figNoPng = await seedFigure(ctx, { ownerId: userA.id, png: null }) // 渲染失败缺省语义
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('owner 下载：原生 PNG 字节直发（豁免信封，Content-Type image/png）', async () => {
    const res = await ctx.request.get(`/api/v1/figures/${figWithPng.id}/png`).set(bearer(accessA))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(Buffer.compare(res.body, TINY_PNG)).toBe(0)
  })

  it('不存在 vs 越权同码 70040 防探测', async () => {
    const missing = await ctx.request.get('/api/v1/figures/no-such/png').set(bearer(accessA))
    const forbidden = await ctx.request.get(`/api/v1/figures/${figWithPng.id}/png`).set(bearer(accessB))
    expect(missing.body.code).toBe(70040)
    expect(forbidden.body.code).toBe(70040)
    expect(missing.body.message).toBe(forbidden.body.message)
  })

  it('admin 跨用户下载放行', async () => {
    const res = await ctx.request.get(`/api/v1/figures/${figWithPng.id}/png`).set(bearer(accessAdmin))
    expect(res.status).toBe(200)
    expect(Buffer.compare(res.body, TINY_PNG)).toBe(0)
  })

  it('png 缺省（渲染失败）→ 70043 确定性「不可用」', async () => {
    const res = await ctx.request.get(`/api/v1/figures/${figNoPng.id}/png`).set(bearer(accessA))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(70043)
  })

  it('未认证 → 10001', async () => {
    const res = await ctx.request.get(`/api/v1/figures/${figWithPng.id}/png`)
    expect(res.body.code).toBe(10001)
  })
})
