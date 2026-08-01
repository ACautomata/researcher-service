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

  // 自查 Spec 轴 P1（缺陷1）：issueSessionInTx 原实现「先查后建」——findFirst 复查 passwordHash
  // 后、refreshToken.create 前，并发改密/reset commit 会让新 refresh 落库且不被 revokeAll 扫到 →
  // 旧凭据存活（TOCTOU）。新实现「先建后查」：create 后 findFirst 命中新 hash → 删刚建的
  // refresh + ok:false。此处用 monkey-patch create 在「建完」后注入并发改密，制造 create 与
  // findFirst 之间的真实交错（SQLite 单连接无法用真并发复现，故以结构化交错驱动）。
  it('并发改密落在 create 与 findFirst 之间 → ok:false 且刚建 refresh 被删除', async () => {
    const admin = await ctx.prisma.user.findUnique({ where: { username: 'admin1' } })
    const activeBefore = await ctx.prisma.refreshToken.count({
      where: { userId: admin!.id, revokedAt: null },
    })
    const rt = ctx.prisma.refreshToken as unknown as Record<string, unknown>
    const origCreate = rt.create
    const origFind = rt.findFirst
    let injected = false
    let createdHash = ''
    rt.create = async function (this: unknown, args: unknown) {
      const a = args as { data: { tokenHash: string } }
      const r = await (origCreate as (x: unknown) => Promise<unknown>).call(this, args)
      createdHash = a.data.tokenHash
      // 模拟并发：refresh 已建但复查前，admin 改密（hash 变了，且 revokeAll 已执行）
      await ctx.prisma.user.update({
        where: { id: admin!.id },
        data: { passwordHash: await hashPassword('intercept-injected-9'), mustChangePassword: true },
      })
      injected = true
      return r
    }
    rt.findFirst = async function (this: unknown, args: unknown) {
      // 拦截只针对 refreshToken.findFirst 复查；探测注入是否发生
      const r = await (origFind as (x: unknown) => Promise<unknown>).call(this, args)
      return r
    }
    try {
      const result = await issueSessionInTx(
        ctx.prisma as never,
        admin!.id,
        admin!.passwordHash!, // 仍是校验时读到的旧 hash（未随并发改密更新）
      )
      expect(injected).toBe(true) // 交错确实被制造
      expect(result).toEqual({ ok: false }) // 复查命中新 hash → 拒绝
      const after = await ctx.prisma.user.findUnique({ where: { id: admin!.id } })
      expect(after!.mustChangePassword).toBe(true) // 并发改密已生效
      // 刚建的 refresh 被删（非撤销）→ 无残留
      const leftover = await ctx.prisma.refreshToken.findUnique({ where: { tokenHash: createdHash } })
      expect(leftover).toBeNull()
      const activeAfter = await ctx.prisma.refreshToken.count({
        where: { userId: admin!.id, revokedAt: null },
      })
      expect(activeAfter).toBe(activeBefore)
    } finally {
      rt.create = origCreate
      rt.findFirst = origFind
    }
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
