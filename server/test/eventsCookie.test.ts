import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, login, findSetCookie } from './helpers'
import { verifyPanelStreamToken } from '../src/auth/tokens'

// 接缝 S1（信封级集成，issue #773）：panel_stream cookie 只读流通道颁发与清除。
// 准据 = #726 认证行：HttpOnly / Secure(prod) / SameSite=Strict / Path=/api/v1/events；
// login/refresh Set-Cookie 滑动续期，logout 清除；REST Bearer 全不动（后续用例锁）。

describe('panel_stream cookie（SSE 只读流通道，#726）', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await setupTestApp()
    await seedAdmin(ctx.prisma)
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('login 颁发 panel_stream：HttpOnly + SameSite=Strict + Path=/api/v1/events', async () => {
    const res = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const c = findSetCookie(res.setCookie, 'panel_stream')
    expect(c, 'login 未颁发 panel_stream cookie').toBeTruthy()
    expect(c!.toLowerCase()).toContain('httponly')
    expect(c!.toLowerCase()).toContain('samesite=strict')
    expect(c).toContain('Path=/api/v1/events')
    // test 环境（NODE_ENV!=='production'）Secure 关（对齐 refresh cookie 断言先例）
  })

  it('panel_stream 是独立签发的流凭证：verify 得 userId，不与 access token 混用', async () => {
    const res = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const c = findSetCookie(res.setCookie, 'panel_stream')!
    const value = /^panel_stream=[^;]+/.exec(c)![0].slice('panel_stream='.length)
    const admin = await ctx.prisma.user.findUnique({ where: { username: 'admin1' } })
    const verified = await verifyPanelStreamToken(decodeURIComponent(value))
    expect(verified.userId).toBe(admin!.id)
    // access token 不能当 panel_stream 用（audience 隔离）
    await expect(verifyPanelStreamToken(res.access!)).rejects.toThrow()
  })

  it('refresh 滑动续期：新 panel_stream Set-Cookie（与 refresh_token 同帧轮换）', async () => {
    const res = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const before = findSetCookie(res.setCookie, 'panel_stream')!.split(';')[0]
    const refreshRes = await ctx.request
      .post('/api/v1/auth/token/refresh')
      .set('Cookie', [res.refreshCookie!])
    expect(refreshRes.body.code).toBe(0)
    const after = findSetCookie(refreshRes.headers['set-cookie'] as unknown as string[], 'panel_stream')!.split(';')[0]
    expect(after.startsWith('panel_stream=')).toBe(true)
    expect(after).not.toBe(before) // 滑动续期 = 重签（jti 不同）
  })

  it('logout 清除 panel_stream（同 Path 过期置空）', async () => {
    const res = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const access = res.access!
    const cleared = await ctx.request
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${access}`)
    expect(cleared.body.code).toBe(0)
    const setCookie = cleared.headers['set-cookie'] as unknown as string[] | undefined
    const c = findSetCookie(setCookie, 'panel_stream')
    expect(c, 'logout 未清除 panel_stream').toBeTruthy()
    expect(c!.toLowerCase()).toContain('expires=thu, 01 jan 1970')
    expect(c).toContain('Path=/api/v1/events')
  })
})
