import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'

// 片9：register（admin-only · 20041 冲突 · 10004 非 admin · 90002 校验）
describe('register (slice 9)', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await setupTestApp()
    await seedAdmin(ctx.prisma)
    await seedUser(ctx.prisma, 'dup', 'pw-dup-secure') // 占位用户名
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('admin 建号 → {id, username, email, role:user} + 新号 mustChange=true', async () => {
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const res = await ctx.request
      .post('/api/v1/auth/register')
      .set(bearer(admin.access))
      .send({ username: 'newuser1', password: 'pw-new-secure', email: 'n@example.com' })
    expect(res.body.code).toBe(0)
    expect(res.body.data).toMatchObject({ username: 'newuser1', email: 'n@example.com', role: 'user' })
    expect(res.body.data).toHaveProperty('id')
    // 凭证零落盘
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/)
    // 新号 mustChange=true
    const row = await ctx.prisma.user.findUnique({ where: { username: 'newuser1' } })
    expect(row!.mustChangePassword).toBe(true)
  })

  it('非 admin 调 → 10004', async () => {
    await seedUser(ctx.prisma, 'plainuser', 'pw-plain-secure')
    const u = await login(ctx.request, 'plainuser', 'pw-plain-secure')
    const res = await ctx.request
      .post('/api/v1/auth/register')
      .set(bearer(u.access))
      .send({ username: 'another', password: 'pw-whatever' })
    expect(res.body.code).toBe(10004)
  })

  it('用户名占用 → 20041', async () => {
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const res = await ctx.request
      .post('/api/v1/auth/register')
      .set(bearer(admin.access))
      .send({ username: 'dup', password: 'pw-whatever' })
    expect(res.body.code).toBe(20041)
  })

  it('用户名格式非法 → 90002(data.username)', async () => {
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const res = await ctx.request
      .post('/api/v1/auth/register')
      .set(bearer(admin.access))
      .send({ username: 'bad name!', password: 'pw-whatever' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('username')
  })

  it('未认证 → 10001（register 受保护）', async () => {
    const res = await ctx.request.post('/api/v1/auth/register').send({ username: 'x', password: 'pw-x' })
    expect(res.body.code).toBe(10001)
  })
})
