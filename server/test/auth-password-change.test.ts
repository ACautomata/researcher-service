import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, login, bearer } from './helpers'
import { hashPassword, verifyPassword } from '../src/auth/password'
import { changePasswordInTx } from '../src/routes/auth'

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

  // 意见④[P1]（Codex 二轮）：密码变更竞态 —— 校验与更新须原子化。
  // 抽 changePasswordInTx 事务体：条件 updateMany 复查 passwordHash==已校验旧 hash，
  // count=0（并发已被重置）→ ok:false 拒绝，不覆盖 reset hash。
  it('竞态：hash 已被重置 → 条件更新 count=0 → ok:false 不覆盖', async () => {
    const admin = await ctx.prisma.user.findUnique({ where: { username: 'admin1' } })
    const oldHash = admin!.passwordHash!
    const newHash = await hashPassword('pw-attacker-owned-1')
    // 1. 正常：hash 未变 → ok:true
    const okNormal = await changePasswordInTx(
      ctx.prisma as never,
      admin!.id,
      oldHash,
      newHash,
      new Date(),
    )
    expect(okNormal.ok).toBe(true)
    // 2. 竞态：先重置 hash（模拟并发 admin 已改密）→ 条件更新 count=0 → ok:false
    await ctx.prisma.user.update({
      where: { id: admin!.id },
      data: { passwordHash: await hashPassword('reset-by-admin-77'), mustChangePassword: true },
    })
    const okStale = await changePasswordInTx(
      ctx.prisma as never,
      admin!.id,
      oldHash, // 仍是旧 hash（校验时读到的值）
      newHash,
      new Date(),
    )
    expect(okStale.ok).toBe(false)
    // reset hash 未被覆盖
    const after = await ctx.prisma.user.findUnique({ where: { id: admin!.id } })
    expect(await verifyPassword('reset-by-admin-77', after!.passwordHash!)).toBe(true)
    expect(await verifyPassword('pw-attacker-owned-1', after!.passwordHash!)).toBe(false)
    expect(after!.mustChangePassword).toBe(true)
  })

  // 意见⑦[P1]（Codex 三轮）：改密 CAS 须复查 isActive —— admin 禁用账号后，攻击者持旧
  // access token + 旧密码仍可改密清 mustChangePassword；条件更新须含 isActive:true，
  // zero-row（账号已禁用）→ ok:false 拒绝，防止重新启用后回归控制。
  it('竞态：账号被禁用（isActive=false）但 hash 匹配 → 条件更新 count=0 → ok:false 不覆盖', async () => {
    const admin = await ctx.prisma.user.findUnique({ where: { username: 'admin1' } })
    const oldHash = admin!.passwordHash!
    const newHash = await hashPassword('pw-attacker-owned-1')
    // 记录禁用前「改密成功的密码」：前面用例已将 admin1 密码设为 pw-brand-new-9（或后续重置）。
    // 此处直接用 verifyPassword 对照 oldHash 的明文可验证性，避免依赖具体历史密码。
    const knownPre = await verifyPassword('reset-by-admin-77', oldHash)
      ? 'reset-by-admin-77'
      : await verifyPassword('pw-brand-new-9', oldHash)
        ? 'pw-brand-new-9'
        : await verifyPassword('pw-admin1-secure', oldHash)
          ? 'pw-admin1-secure'
          : null
    expect(knownPre).not.toBeNull()
    // 模拟竞态：verify 通过后、事务前 admin 禁用该账号（isActive=false，hash 未变）
    await ctx.prisma.user.update({
      where: { id: admin!.id },
      data: { isActive: false },
    })
    const okDisabled = await changePasswordInTx(
      ctx.prisma as never,
      admin!.id,
      oldHash, // hash 仍匹配，但账号已禁用
      newHash,
      new Date(),
    )
    expect(okDisabled.ok).toBe(false)
    // 未被覆盖：仍可验证旧密码（hash 未变）
    const after = await ctx.prisma.user.findUnique({ where: { id: admin!.id } })
    expect(await verifyPassword(knownPre!, after!.passwordHash!)).toBe(true)
    expect(await verifyPassword('pw-attacker-owned-1', after!.passwordHash!)).toBe(false)
  })
})
