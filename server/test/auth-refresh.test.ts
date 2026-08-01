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

  // 意见⑩[P2]（Codex 四轮）：refresh cookie 运行时类型 —— cookie-parser 对 j: 前缀 JSON cookie
  // 解析为对象，hashToken 的 crypto.update 抛 TypeError → 90000。须在 hash 前拒绝非 string。
  it('JSON cookie（非 string）→ 10003 而非 90000', async () => {
    const res = await ctx.request
      .post('/api/v1/auth/token/refresh')
      .set('Cookie', ['refresh_token=j:{"x":1}'])
    expect(res.body.code).toBe(10003)
  })

  it('logout 同样拒绝非 string cookie → 10001（未认证）或正常撤销，不 90000', async () => {
    const res = await ctx.request
      .post('/api/v1/auth/logout')
      .set('Cookie', ['refresh_token=j:{"x":1}'])
    // 无 access token → 10001；重点是不 90000（未因对象 cookie 抛错）
    expect([10001, 0]).toContain(res.body.code)
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

  it('并发旋转原子性：同 cookie 并行 refresh 恰一个成功，无 fork（旋转链不分叉）', async () => {
    const res = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const cookie = res.refreshCookie!
    // 6 路并发提高两请求同时读到 revokedAt:null 的概率（SQLite 单写者下仍可能全串行）
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        ctx.request.post('/api/v1/auth/token/refresh').set('Cookie', [cookie]),
      ),
    )
    const codes = results.map((r) => r.body.code)
    const ok = codes.filter((c) => c === 0).length
    const invalid = codes.filter((c) => c === 10003).length
    expect(ok).toBeGreaterThanOrEqual(1) // 至少一次成功旋转
    expect(ok).toBe(1) // 恰一个成功 —— fork 时会是 ≥2
    expect(ok + invalid).toBe(results.length)
    // 无 fork：该 user 有效 refresh 至多 1 条（0 = 族灭后的合法态）
    const admin = await ctx.prisma.user.findUnique({ where: { username: 'admin1' } })
    const active = await ctx.prisma.refreshToken.count({
      where: { userId: admin!.id, revokedAt: null },
    })
    expect(active).toBeLessThanOrEqual(1)
  })
})
