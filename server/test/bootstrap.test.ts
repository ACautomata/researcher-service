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

  // 意见⑤[P2]（Codex 二轮）：bootstrap 并发启动安全 —— count()==0 与 create 非原子，
  // 两进程同对空库双创建 → 一个 P2002 失败 abort 启动。并发创建应视为成功（幂等）。
  it('并发启动竞态：count()==0 但 create 撞唯一冲突（P2002）→ 视为并发成功，不抛错', async () => {
    // 模拟并发：count() 返回 0（另一进程还没 create），create 却撞 username 唯一冲突。
    // Prisma 代理对象上 spyOn/mockRestore 不可靠，改用临时 monkey-patch + 手写恢复。
    const origCount = ctx.prisma.user.count.bind(ctx.prisma.user)
    const origCreate = ctx.prisma.user.create.bind(ctx.prisma.user)
    ctx.prisma.user.count = (async () => 0) as never
    ctx.prisma.user.create = (async () => {
      throw { code: 'P2002' }
    }) as never
    try {
      await expect(bootstrap(ctx.prisma)).resolves.toBeUndefined()
    } finally {
      ctx.prisma.user.count = origCount
      ctx.prisma.user.create = origCreate
    }
    // 未双写：库里用户数保持原样
    const count = await ctx.prisma.user.count()
    expect(count).toBe(1) // 既有 admin 保留（本文件首个用例已建）
  })
})
