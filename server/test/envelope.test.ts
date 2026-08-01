import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'

// 片1：信封 + health + 10001
describe('envelope + health (slice 1)', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await setupTestApp()
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('GET /api/health → 200 {code:0, message, data:{status:"ok"}}', async () => {
    const res = await ctx.request.get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ code: 0, message: 'ok', data: { status: 'ok' } })
  })

  it('未认证打受保护端点 → HTTP 200 + 信封 10001 + data=null', async () => {
    const res = await ctx.request.get('/api/v1/auth/me')
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(10001)
    expect(res.body.data).toBeNull()
  })

  it('坏 access token → 10001', async () => {
    const res = await ctx.request.get('/api/v1/auth/me').set('Authorization', 'Bearer garbage')
    expect(res.body.code).toBe(10001)
  })

  it('不存在的路由 → HTTP 200 + 信封（非 Express 404）', async () => {
    const res = await ctx.request.get('/api/does-not-exist')
    expect(res.status).toBe(200)
    expect(res.body.code).not.toBe(0)
  })
})
