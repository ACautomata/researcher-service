import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { login, bearer } from './helpers'
import { bootstrap } from '../src/auth/bootstrap'

// 片8：mustChangePassword 服务端拦截（10005）
describe('mustChangePassword gate (slice 8)', () => {
  let ctx: TestContext
  let bootstrapPw: string

  beforeAll(async () => {
    ctx = await setupTestApp()
    // 用真实 bootstrap：空表生成 admin（mustChange=true），捕获明文密码
    const logs: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => {
      logs.push(a.join(' '))
    }
    await bootstrap(ctx.prisma)
    console.log = orig
    const m = /临时密码[:：]\s*([^\s）)]+)/.exec(logs.find((l) => /\[bootstrap\]/.test(l)) ?? '')
    bootstrapPw = m![1]
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('mustChange=true 的 admin 打 /users → 10005', async () => {
    const res = await login(ctx.request, 'admin', bootstrapPw)
    const users = await ctx.request.get('/api/v1/users').set(bearer(res.access))
    expect(users.body.code).toBe(10005)
  })

  it('mustChange=true 时仍可访问放行端点（/me、/password/change、/logout）', async () => {
    const res = await login(ctx.request, 'admin', bootstrapPw)
    const me = await ctx.request.get('/api/v1/auth/me').set(bearer(res.access))
    expect(me.body.code).toBe(0)
    expect(me.body.data.mustChangePassword).toBe(true)

    const change = await ctx.request
      .post('/api/v1/auth/password/change')
      .set(bearer(res.access))
      .send({ oldPassword: bootstrapPw, newPassword: 'pw-changed-99' })
    expect(change.body.code).toBe(0)
  })

  it('改密后 mustChange 清除 → /users 放行', async () => {
    const res = await login(ctx.request, 'admin', 'pw-changed-99')
    const users = await ctx.request.get('/api/v1/users').set(bearer(res.access))
    expect(users.body.code).toBe(0)
    expect(Array.isArray(users.body.data.users)).toBe(true)
  })
})
