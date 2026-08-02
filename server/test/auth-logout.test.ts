import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, login, bearer } from './helpers'
import { hashToken } from '../src/auth/tokens'

// 片6：logout（服务端撤销 + 清 cookie）。cookie 显式带，不依赖 supertest 罐。
describe('logout (slice 6)', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await setupTestApp()
    await seedAdmin(ctx.prisma)
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('logout 需 access；成功返 null + 清 cookie + refresh 撤销', async () => {
    const res = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const cookieA = res.refreshCookie!
    expect(cookieA).toBeTruthy()

    const out = await ctx.request
      .post('/api/v1/auth/logout')
      .set(bearer(res.access))
      .set('Cookie', [cookieA])
    expect(out.body.code).toBe(0)
    expect(out.body.data).toBeNull()
    // cookie 被清除（Set-Cookie 带空值/过期）
    const setCookie = out.headers['set-cookie'] as unknown as string[] | undefined
    expect(setCookie?.some((c) => /refresh_token=;/.test(c))).toBe(true)

    // 该 refresh 已撤销
    const row = await ctx.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(cookieA.split('=')[1]) },
    })
    expect(row?.revokedAt).not.toBeNull()
  })

  it('logout 后旧 refresh 失效（再 refresh → 10003）', async () => {
    const res = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const cookieA = res.refreshCookie!
    await ctx.request.post('/api/v1/auth/logout').set(bearer(res.access)).set('Cookie', [cookieA])
    const again = await ctx.request.post('/api/v1/auth/token/refresh').set('Cookie', [cookieA])
    expect(again.body.code).toBe(10003)
  })

  it('logout 无 access → 10001', async () => {
    const res = await ctx.request.post('/api/v1/auth/logout')
    expect(res.body.code).toBe(10001)
  })
})
