import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import { verifyPassword, hashPassword } from '../src/auth/password'
import { resetPasswordInTx } from '../src/routes/users'

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

  // 意见⑫[P2]（Codex 五轮）：quota 未绑 Prisma Int 范围 —— maxContainers 超 2,147,483,647
  // zod int() 接受但 Prisma Int 列存不了 → 90000。须共享上界，超界 → 10043 拒绝。
  it('PATCH 配额超 Int 上界（2147483648）→ 10043 而非 90000', async () => {
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const res = await ctx.request
      .patch(`/api/v1/users/${targetId}`)
      .set(bearer(admin.access))
      .send({ maxContainers: 2147483648 })
    expect(res.body.code).toBe(10043)
  })

  it('POST 建号配额超 Int 上界（2147483648）→ 10043 而非 90000', async () => {
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const res = await ctx.request
      .post('/api/v1/users')
      .set(bearer(admin.access))
      .send({ username: 'quotaHuge', password: 'pw-quota-secure', maxContainers: 2147483648 })
    expect(res.body.code).toBe(10043)
  })

  // 自查 Spec 轴 P2（缺陷2）：reset 原实现无条件 update → 并发禁用/改密后仍写密码，回显密码会
  // 被覆盖（last-write-wins），破坏「一次性明文回显」。修复：CAS 条件 updateMany（where isActive:true）
  // 与改密同语义互斥，count=0 → 拒绝（不回显将失效的密码）。确定性用例：目标已被禁用 → 10041。
  it('reset-password 目标已被禁用 → 拒绝（不回显将失效的密码）', async () => {
    const disabledTarget = await seedUser(ctx.prisma, 'reset-disabled', 'pw-reset-disabled-1')
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    // 禁用目标（并发/先前状态：目标不可登录）
    await ctx.prisma.user.update({ where: { id: disabledTarget.id }, data: { isActive: false } })
    const res = await ctx.request
      .post(`/api/v1/users/${disabledTarget.id}/reset-password`)
      .set(bearer(admin.access))
    // CAS count=0 → 拒绝；不回显密码
    expect(res.body.code).toBe(10041)
    expect(res.body.data).toBeNull()
    // 密码未被覆盖（仍可验证原密码）
    const row = await ctx.prisma.user.findUnique({ where: { id: disabledTarget.id } })
    expect(await verifyPassword('pw-reset-disabled-1', row!.passwordHash!)).toBe(true)
    expect(row!.mustChangePassword).toBe(false)
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

  // 意见②⑦[P2]（Codex ⑮ 轮）：并发 reset-password 竞态 —— 两个 admin 同时 reset 同一账号，
  // 各自 findUnique 读到同一旧 hash H，更新谓词只有 id+isActive → 双双成功返回不同明文，后写覆盖
  // 先写，破坏「一次性明文回显」（admin 回显的密码可能已失效）。修复：reset 抽 resetPasswordInTx
  // seam，条件 updateMany 复查 passwordHash==expectedHash（与改密 CAS 同语义），count=0（并发已
  // reset，hash 已变）→ ok:false 拒绝，不覆盖并发写。
  it('竞态：并发已 reset（hash 已变）→ 条件更新 count=0 → ok:false 不覆盖', async () => {
    const row = await ctx.prisma.user.findUnique({ where: { id: targetId } })
    const oldHash = row!.passwordHash!
    // 两笔并发 reset 各自生成独立明文（真实场景：两次 admin 操作返回不同临时密码）
    const firstPw = 'reset-concurrent-first'
    const stalePw = 'reset-concurrent-stale'
    // 1. 正常：hash 未变 → ok:true（首笔 reset 成功）
    const okFirst = await resetPasswordInTx(
      ctx.prisma as never,
      targetId,
      oldHash,
      await hashPassword(firstPw),
      new Date(),
    )
    expect(okFirst.ok).toBe(true)
    // 2. 竞态：并发已先 reset（hash 已变），旧 expectedHash 已失效 → count=0 → ok:false
    const okStale = await resetPasswordInTx(
      ctx.prisma as never,
      targetId,
      oldHash, // 仍是首笔前的旧 hash（首笔 reset 的响应还没被使用）
      await hashPassword(stalePw),
      new Date(),
    )
    expect(okStale.ok).toBe(false)
    // 未被覆盖：仍可用首笔 reset 的密码验证（并发笔的明文未生效）
    const after = await ctx.prisma.user.findUnique({ where: { id: targetId } })
    expect(await verifyPassword(firstPw, after!.passwordHash!)).toBe(true)
    expect(await verifyPassword(stalePw, after!.passwordHash!)).toBe(false)
    expect(after!.mustChangePassword).toBe(true)
  })
})
