import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'

// 片4：me（扩 role/mustChangePassword/maxContainers）
describe('me (slice 4)', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await setupTestApp()
    await seedAdmin(ctx.prisma)
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('GET /me → {id, username, email, role, mustChangePassword, maxContainers}', async () => {
    const res = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const me = await ctx.request.get('/api/v1/auth/me').set(bearer(res.access))
    expect(me.body.code).toBe(0)
    expect(me.body.data).toMatchObject({
      username: 'admin1',
      role: 'admin',
      mustChangePassword: false,
      maxContainers: 3,
    })
    expect(me.body.data).toHaveProperty('id')
    expect(me.body.data).toHaveProperty('email')
    // 凭证零落盘
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash/)
  })

  it('无 token → 10001', async () => {
    const res = await ctx.request.get('/api/v1/auth/me')
    expect(res.body.code).toBe(10001)
  })

  it('mustChangePassword=true 的 user 在 /me 仍可读（gate 放行 /me）', async () => {
    await seedUser(ctx.prisma, 'mcuser', 'pw-mcuser-secure', { mustChangePassword: true })
    const res = await login(ctx.request, 'mcuser', 'pw-mcuser-secure')
    const me = await ctx.request.get('/api/v1/auth/me').set(bearer(res.access))
    expect(me.body.code).toBe(0)
    expect(me.body.data.mustChangePassword).toBe(true)
  })
})
