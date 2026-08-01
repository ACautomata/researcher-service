import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, login, assertRefreshCookieShape } from './helpers'
import * as passwordMod from '../src/auth/password'
import { hashPassword } from '../src/auth/password'
import { issueSessionInTx } from '../src/routes/auth'

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

  // 意见⑨[P2]（Codex 四轮）：bcrypt 72 字节截断 —— bcryptjs 截断 >72 字节的密码，首 72 字节
  // 相同而后续不同的两个密码可互登。schema 须加共享 72 字节上限，超长密码提交即 90002。
  it('超 72 字节密码 → 90002（拒绝 bcrypt 截断碰撞面）', async () => {
    const over72 = 'a'.repeat(72) + 'AAAA' // 76 字节 > 72
    const res = await ctx.request
      .post('/api/v1/auth/login')
      .send({ username: 'admin1', password: over72 })
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('password')
  })

  it('禁用用户 → 10002', async () => {
    await seedUserDisabled(ctx)
    const res = await login(ctx.request, 'disabled1', 'pw-disabled1-secure')
    expect(res.body.code).toBe(10002)
  })

  // 意见⑪[P1]（Codex 五轮）：login 发 refresh 前未复查 —— 验证密码后并发改密/reset commit
  // 会撤销旧 refresh 并改 hash，login 仍插入基于过期密码的新 refresh → 旧凭据存活。
  // issueSessionInTx 事务内条件复查 passwordHash + isActive，任一变化 → ok:false 拒绝。
  it('并发改密后（hash 已变）→ issueSessionInTx 拒绝且不 create refresh', async () => {
    const admin = await ctx.prisma.user.findUnique({ where: { username: 'admin1' } })
    const oldHash = admin!.passwordHash!
    const activeBefore = await ctx.prisma.refreshToken.count({
      where: { userId: admin!.id, revokedAt: null },
    })
    // 模拟并发：verify 通过后、create 前 admin 改密（hash 变了）
    await ctx.prisma.user.update({
      where: { id: admin!.id },
      data: { passwordHash: await hashPassword('reset-by-admin-88'), mustChangePassword: true },
    })
    const result = await issueSessionInTx(
      ctx.prisma as never,
      admin!.id,
      oldHash, // 仍是校验时读到的旧 hash
    )
    expect(result).toEqual({ ok: false }) // 复查失败 → 拒绝
    const activeAfter = await ctx.prisma.refreshToken.count({
      where: { userId: admin!.id, revokedAt: null },
    })
    expect(activeAfter).toBe(activeBefore) // 未插入新 refresh（旧凭据不存活）
  })

  // 意见③[P2]：时序侧信道防护（Codex #342）—— 短路分支（不存在/OIDC-only/inactive）也跑
  // 一次 verifyPassword 垫恒定耗时，抹平与「错密跑满 cost-12」的时序差。
  it('时序防护：用户不存在等短路分支也调用 verifyPassword（垫恒定耗时）', async () => {
    const spy = vi.spyOn(passwordMod, 'verifyPassword')
    try {
      // 用户不存在（短路分支）
      await login(ctx.request, 'ghost-2', 'whatever')
      // OIDC-only：无 passwordHash 用户
      await seedAdmin(ctx.prisma, 'oidc-only-1', '', { passwordHash: null })
      await login(ctx.request, 'oidc-only-1', 'whatever')
      // 禁用用户
      await login(ctx.request, 'disabled1', 'whatever')
      // 断言短路分支共触发 ≥3 次 verifyPassword（每次恒垫 bcrypt 耗时）
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3)
      // 且每个调用都真实对 hash 执行（非空 hash）
      for (const args of spy.mock.calls) {
        expect(args[1]).toBeTruthy()
      }
    } finally {
      spy.mockRestore()
    }
  })

  async function seedUserDisabled(c: TestContext): Promise<void> {
    await seedAdmin(c.prisma, 'disabled1', 'pw-disabled1-secure', { isActive: false, role: 'user' })
  }
})
