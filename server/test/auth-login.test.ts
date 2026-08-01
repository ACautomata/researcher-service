import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, login, assertRefreshCookieShape } from './helpers'

// 片3：login
describe('login (slice 3)', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await setupTestApp()
    await seedAdmin(ctx.prisma)
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('正确凭证 → access + mustChangePassword + Set-Cookie(HttpOnly/SameSite=Lax/Path=/api/v1/auth)', async () => {
    const res = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data!.access).toBeTruthy()
    expect(res.body.data!.mustChangePassword).toBe(false)
    assertRefreshCookieShape(res.setCookie)
    // 凭证零落盘
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|refresh_token/)
  })

  it('错误密码 → 10002（不暴露用户名是否存在）', async () => {
    const res = await login(ctx.request, 'admin1', 'wrong-password')
    expect(res.body.code).toBe(10002)
    expect(res.body.data).toBeNull()
  })

  it('不存在用户 → 同样 10002（防探测）', async () => {
    const res = await login(ctx.request, 'ghost', 'whatever')
    expect(res.body.code).toBe(10002)
  })

  it('坏 body（缺字段） → 90002 + 字段明细', async () => {
    const res = await ctx.request.post('/api/v1/auth/login').send({ username: 'admin1' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toBeTruthy()
    expect(res.body.data).toHaveProperty('password')
  })

  it('禁用用户 → 10002', async () => {
    await seedUserDisabled(ctx)
    const res = await login(ctx.request, 'disabled1', 'pw-disabled1-secure')
    expect(res.body.code).toBe(10002)
  })

  async function seedUserDisabled(c: TestContext): Promise<void> {
    await seedAdmin(c.prisma, 'disabled1', 'pw-disabled1-secure', { isActive: false, role: 'user' })
  }
})
