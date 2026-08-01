import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, login, assertRefreshCookieShape } from './helpers'
import * as passwordMod from '../src/auth/password'

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
