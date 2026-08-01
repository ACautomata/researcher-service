import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, login, bearer } from './helpers'

// 片7：password/change（清 mustChange + 撤全部 refresh + 旧密错 10002）
describe('password/change (slice 7)', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await setupTestApp()
    await seedAdmin(ctx.prisma)
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('旧密正确 → 清 mustChange + 撤该 user 全部 refresh + cookie 清', async () => {
    const res = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const change = await ctx.request
      .post('/api/v1/auth/password/change')
      .set(bearer(res.access))
      .send({ oldPassword: 'pw-admin1-secure', newPassword: 'pw-brand-new-9' })
    expect(change.body.code).toBe(0)
    expect(change.body.data).toBeNull()

    const me = await ctx.request.get('/api/v1/auth/me').set(bearer(res.access))
    expect(me.body.data.mustChangePassword).toBe(false)

    // 全部 refresh 撤销
    const admin = await ctx.prisma.user.findUnique({ where: { username: 'admin1' } })
    const active = await ctx.prisma.refreshToken.count({ where: { userId: admin!.id, revokedAt: null } })
    expect(active).toBe(0)
  })

  it('旧密错 → 10002', async () => {
    const res = await login(ctx.request, 'admin1', 'pw-brand-new-9')
    const change = await ctx.request
      .post('/api/v1/auth/password/change')
      .set(bearer(res.access))
      .send({ oldPassword: 'wrong', newPassword: 'pw-another-99' })
    expect(change.body.code).toBe(10002)
  })

  it('坏 body（newPassword 过短）→ 90002 + 字段明细', async () => {
    const res = await login(ctx.request, 'admin1', 'pw-brand-new-9')
    const change = await ctx.request
      .post('/api/v1/auth/password/change')
      .set(bearer(res.access))
      .send({ oldPassword: 'pw-brand-new-9', newPassword: 'short' })
    expect(change.body.code).toBe(90002)
    expect(change.body.data).toHaveProperty('newPassword')
  })
})
