import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { bootstrap } from '../src/auth/bootstrap'
import { login } from './helpers'

// 片2：bootstrap B1（空表惰性生成 admin、明文密码 log 一次、mustChangePassword=true）
describe('bootstrap B1 (slice 2)', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await setupTestApp()
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  function captureLogs(fn: () => Promise<void>): { logs: string[]; ran: Promise<void> } {
    const logs: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => {
      logs.push(a.join(' '))
    }
    const ran = fn().finally(() => {
      console.log = orig
    })
    return { logs, ran }
  }

  it('空库首启 → 建 admin、mustChangePassword=true、明文密码 log 恰好一次且可登录', async () => {
    const { logs, ran } = captureLogs(() => bootstrap(ctx.prisma))
    await ran

    const admin = await ctx.prisma.user.findUnique({ where: { username: 'admin' } })
    expect(admin).not.toBeNull()
    expect(admin!.role).toBe('admin')
    expect(admin!.mustChangePassword).toBe(true)
    expect(admin!.passwordHash).toBeTruthy()

    const pwLines = logs.filter((l) => /\[bootstrap\]/.test(l))
    expect(pwLines.length).toBe(1) // 明文密码仅 log 一次
    const m = /临时密码[:：]\s*([^\s）)]+)/.exec(pwLines[0])
    expect(m).not.toBeNull()
    const plaintext = m![1]
    expect(plaintext.length).toBeGreaterThanOrEqual(16)
    // passwordHash 与明文不同（bcrypt）
    expect(plaintext).not.toBe(admin!.passwordHash)

    // 该明文可登录且 mustChangePassword=true
    const res = await login(ctx.request, 'admin', plaintext)
    expect(res.body.code).toBe(0)
    expect(res.body.data!.mustChangePassword).toBe(true)
    // 凭证零落盘：响应体不含 passwordHash / 明文
    const body = JSON.stringify(res.body)
    expect(body).not.toMatch(/passwordHash/)
    expect(body).not.toContain(plaintext)
  })

  it('幂等：非空库再 bootstrap 不重复建、不再 log', async () => {
    const { logs, ran } = captureLogs(() => bootstrap(ctx.prisma))
    await ran
    const count = await ctx.prisma.user.count()
    expect(count).toBe(1)
    expect(logs.some((l) => /\[bootstrap\]/.test(l))).toBe(false)
  })
})
