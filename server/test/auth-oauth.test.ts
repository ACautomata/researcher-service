import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'

// 片13：OAuth2 O1 骨架（不接 IdP → 90001）
describe('oauth skeleton (slice 13)', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await setupTestApp()
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('GET /oauth/<provider>/login → 90001', async () => {
    const res = await ctx.request.get('/api/v1/auth/oauth/github/login')
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(90001)
    expect(res.body.data).toBeNull()
  })

  it('GET /oauth/<provider>/callback → 90001', async () => {
    const res = await ctx.request.get('/api/v1/auth/oauth/github/callback?code=x&state=y')
    expect(res.body.code).toBe(90001)
  })
})
