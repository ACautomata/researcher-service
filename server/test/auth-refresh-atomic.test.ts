import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, login } from './helpers'
import { hashToken } from '../src/auth/tokens'
import { rotateInTx } from '../src/routes/auth'

// 意见②[P1]：旋转原子性 —— 条件 updateMany + zero-row 判定（Codex #342）。
// rotateInTx 是事务体内核（可测 seam）：并发已被旋转（updateMany count=0）→ replay:true，
// 调用方据此族灭 + 10003。本测试确定性构造"并发竞态"：A 已被旋转撤销后，仍用 A 的
// 旧 row 视图调用 rotateInTx —— 条件 updateMany 命中 count=0 → 不 create 新 token。
describe('refresh 旋转原子性（Codex #342）', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await setupTestApp()
    await seedAdmin(ctx.prisma)
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('并发已被旋转：条件 updateMany 命中 count=0 → replay:true，且不 create 新 token', async () => {
    // 1. login 拿 token A
    const res = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const tokenA = res.refreshCookie!.split('=')[1]
    const rowA = await ctx.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(tokenA) },
    })
    expect(rowA).toBeTruthy()
    expect(rowA!.revokedAt).toBeNull()

    // 2. 模拟并发第一条请求已完成旋转：先手动撤销 A（等价于另一并发请求撤销）
    const now = new Date()
    await ctx.prisma.refreshToken.update({
      where: { id: rowA!.id },
      data: { revokedAt: now },
    })

    // 3. 并发第二条请求仍持有"未撤销"的过期 row 视图，走 rotateInTx 事务内核
    const before = await ctx.prisma.refreshToken.count()
    const result = await rotateInTx(
      ctx.prisma as never,
      { id: rowA!.id, userId: rowA!.userId },
      now,
    )
    expect(result).toEqual({ replay: true }) // 条件撤销 count=0 → 判重放
    const after = await ctx.prisma.refreshToken.count()
    expect(after).toBe(before) // 未 create 新 token → 无 fork
  })

  it('正常路径：未撤销未过期 → replay:false + 新 token 落库（撤销旧 + 建新原子）', async () => {
    const res = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const tokenA = res.refreshCookie!.split('=')[1]
    const rowA = await ctx.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(tokenA) },
    })
    const result = await rotateInTx(
      ctx.prisma as never,
      { id: rowA!.id, userId: rowA!.userId },
      new Date(),
    )
    expect(result.replay).toBe(false)
    // 旧 token 已撤销 + 新 token 落库
    const oldRow = await ctx.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(tokenA) },
    })
    expect(oldRow!.revokedAt).not.toBeNull()
    const active = await ctx.prisma.refreshToken.count({
      where: { userId: rowA!.userId, revokedAt: null },
    })
    expect(active).toBe(1) // 恰一条有效 → 无 fork
  })
})
