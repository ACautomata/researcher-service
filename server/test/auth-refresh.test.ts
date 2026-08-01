import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, login } from './helpers'
import { hashToken, generateRefreshToken } from '../src/auth/tokens'

// 片5：refresh R1 旋转 + 重放检测（cookie 全显式，不依赖 supertest cookie 罐）
describe('refresh R1 (slice 5)', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await setupTestApp()
    await seedAdmin(ctx.prisma)
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('refresh 旋转：旧 refresh 撤销、出新 access、cookie 轮换', async () => {
    const res = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const cookieA = res.refreshCookie!
    expect(cookieA).toBeTruthy()
    const access1 = res.body.data!.access!

    const refreshRes = await ctx.request.post('/api/v1/auth/token/refresh').set('Cookie', [cookieA])
    expect(refreshRes.body.code).toBe(0)
    const access2 = refreshRes.body.data!.access
    expect(access2).toBeTruthy()
    expect(access2).not.toBe(access1) // 新 access（jti/iat 不同）
    // 新 cookie 下发
    const cookieB = refreshRes.headers['set-cookie'] as unknown as string[] | undefined
    expect(cookieB?.some((c) => c.startsWith('refresh_token='))).toBe(true)

    // 旧 refresh 已撤销
    const oldRow = await ctx.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(cookieA.split('=')[1]) },
    })
    expect(oldRow?.revokedAt).not.toBeNull()
  })

  it('重放检测：旧 cookie 复用 → 10003 + 族灭（该 user 全部 refresh 撤销）', async () => {
    const res = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const cookieA = res.refreshCookie!
    // 正常旋转一次
    await ctx.request.post('/api/v1/auth/token/refresh').set('Cookie', [cookieA])
    // 用同一旧 cookie A 重放
    const replay = await ctx.request.post('/api/v1/auth/token/refresh').set('Cookie', [cookieA])
    expect(replay.body.code).toBe(10003)
    // 族灭：该 user 全部有效 refresh 归零
    const admin = await ctx.prisma.user.findUnique({ where: { username: 'admin1' } })
    const active = await ctx.prisma.refreshToken.count({ where: { userId: admin!.id, revokedAt: null } })
    expect(active).toBe(0)
  })

  it('无 cookie → 10003', async () => {
    const res = await ctx.request.post('/api/v1/auth/token/refresh')
    expect(res.body.code).toBe(10003)
  })

  it('过期 refresh → 10003', async () => {
    const admin = await ctx.prisma.user.findUnique({ where: { username: 'admin1' } })
    const { token, hash } = generateRefreshToken()
    await ctx.prisma.refreshToken.create({
      data: { userId: admin!.id, tokenHash: hash, expiresAt: new Date(Date.now() - 1000) },
    })
    const res = await ctx.request
      .post('/api/v1/auth/token/refresh')
      .set('Cookie', [`refresh_token=${token}`])
    expect(res.body.code).toBe(10003)
  })
})
