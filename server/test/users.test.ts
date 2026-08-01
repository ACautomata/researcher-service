import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'

// 片10/11/12：users 4 端点（GET+containerCount / POST / PATCH / reset-password）
describe('users admin (slice 10/11/12)', () => {
  let ctx: TestContext
  let adminId: string
  let targetId: string

  beforeAll(async () => {
    ctx = await setupTestApp()
    const admin = await seedAdmin(ctx.prisma)
    adminId = admin.id
    const target = await seedUser(ctx.prisma, 'target', 'pw-target-secure')
    targetId = target.id
    // target 持有 2 个容器 → containerCount=2
    await ctx.prisma.container.createMany({
      data: [
        { name: 'c-a', port: 19000, ownerId: targetId, token: '', homeDir: '/h/a', image: 'img', status: 'creating' },
        { name: 'c-b', port: 19001, ownerId: targetId, token: '', homeDir: '/h/b', image: 'img', status: 'running' },
      ],
    })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('admin GET /users → 每行含 username/role/isActive/containerCount/quota/mustChangePassword/createdAt', async () => {
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const res = await ctx.request.get('/api/v1/users').set(bearer(admin.access))
    expect(res.body.code).toBe(0)
    const users = res.body.data.users as Record<string, unknown>[]
    const target = users.find((u) => u.username === 'target')!
    expect(target.containerCount).toBe(2)
    expect(target.quota).toEqual({ used: 2, limit: 3 })
    expect(target).toHaveProperty('role')
    expect(target).toHaveProperty('isActive')
    expect(target).toHaveProperty('mustChangePassword')
    expect(target).toHaveProperty('createdAt')
    // 凭证零落盘
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/)
  })

  it('非 admin GET /users → 10041（与 not-found 同码，非 10004）', async () => {
    await seedUser(ctx.prisma, 'plainuser', 'pw-plain-secure')
    const u = await login(ctx.request, 'plainuser', 'pw-plain-secure')
    const res = await ctx.request.get('/api/v1/users').set(bearer(u.access))
    expect(res.body.code).toBe(10041)
  })

  it('admin POST /users → 建号', async () => {
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const res = await ctx.request
      .post('/api/v1/users')
      .set(bearer(admin.access))
      .send({ username: 'madebyadmin', password: 'pw-made-secure' })
    expect(res.body.code).toBe(0)
    expect(res.body.data).toMatchObject({ username: 'madebyadmin', role: 'user' })
  })

  it('admin PATCH /users/:id 禁用他人 → isActive=false', async () => {
    const disableme = await seedUser(ctx.prisma, 'disableme', 'pw-disable-secure')
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const res = await ctx.request
      .patch(`/api/v1/users/${disableme.id}`)
      .set(bearer(admin.access))
      .send({ isActive: false })
    expect(res.body.code).toBe(0)
    expect(res.body.data.isActive).toBe(false)
  })

  it('admin 自禁 → 10044', async () => {
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const res = await ctx.request
      .patch(`/api/v1/users/${adminId}`)
      .set(bearer(admin.access))
      .send({ isActive: false })
    expect(res.body.code).toBe(10044)
  })

  it('配额非法（负数）→ 10043', async () => {
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const res = await ctx.request
      .patch(`/api/v1/users/${targetId}`)
      .set(bearer(admin.access))
      .send({ maxContainers: -1 })
    expect(res.body.code).toBe(10043)
  })

  it('admin POST /users 配额非法（负数）→ 10043（与 PATCH 共用 createUser 校验）', async () => {
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const res = await ctx.request
      .post('/api/v1/users')
      .set(bearer(admin.access))
      .send({ username: 'quotaBad', password: 'pw-quota-secure', maxContainers: -5 })
    expect(res.body.code).toBe(10043)
  })

  it('不存在 id → 10041（防探测）', async () => {
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const res = await ctx.request
      .patch('/api/v1/users/nonexistent-id')
      .set(bearer(admin.access))
      .send({ isActive: false })
    expect(res.body.code).toBe(10041)
    expect(res.body.data).toBeNull()
  })

  it('防探测一致性：不存在 id 与非 admin 访问 → 同码同文案同空 data', async () => {
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const notFound = await ctx.request
      .post('/api/v1/users/nonexistent-id/reset-password')
      .set(bearer(admin.access))
    const u = await login(ctx.request, 'plainuser', 'pw-plain-secure')
    const nonAdmin = await ctx.request
      .post(`/api/v1/users/${targetId}/reset-password`)
      .set(bearer(u.access))
    expect(notFound.body).toEqual(nonAdmin.body) // code/message/data 逐字节一致
  })

  it('admin reset-password → 一次性明文 + 目标 mustChange=true + 撤全部 refresh', async () => {
    // target 先 login 拿一个 refresh
    const targetLogin = await login(ctx.request, 'target', 'pw-target-secure')
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const res = await ctx.request
      .post(`/api/v1/users/${targetId}/reset-password`)
      .set(bearer(admin.access))
    expect(res.body.code).toBe(0)
    const pw = res.body.data.password as string
    expect(pw.length).toBeGreaterThanOrEqual(16)
    // 目标 mustChange=true
    const row = await ctx.prisma.user.findUnique({ where: { id: targetId } })
    expect(row!.mustChangePassword).toBe(true)
    // 旧 refresh 失效（target 旧 cookie 再 refresh → 10003）
    const again = await ctx.request
      .post('/api/v1/auth/token/refresh')
      .set('Cookie', [targetLogin.refreshCookie!])
    expect(again.body.code).toBe(10003)
    // 新明文可登录且 mustChange=true
    const relogin = await login(ctx.request, 'target', pw)
    expect(relogin.body.code).toBe(0)
    expect(relogin.body.data!.mustChangePassword).toBe(true)
  })
})
