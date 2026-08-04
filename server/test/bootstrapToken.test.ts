// containers bootstrap-token REST 测试（接缝 #2 信封 + ADR 0006 D1 / #369 接线前置）。
// 覆盖：归属门（user 仅自己 / admin 全放行）/ 越权与不存在同码 20040 字节级一致 / 解密值 /
// 遗留明文行 / 非法 name / 未认证。协议机首连须 bootstrap auth，本端点是 ChatView 连网关的前提。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import supertest from 'supertest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import { AesGcmCrypto } from '../src/crypto'
import { config } from '../src/config'
import { createApp } from '../src/app'

describe('containers bootstrap-token（ADR 0006 D1 / #369）', () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestApp()
    // containers 路由在 orchestrator 注入时才挂载（app.ts）；bootstrap-token 仅用归属门 + 解密，
    // 不触编排器任何方法——注入空壳仅让路由挂载。
    const app = createApp({ prisma: ctx.prisma, orchestrator: {} as never })
    ctx.request = supertest(app) as unknown as TestContext['request']
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  // 容器 GATEWAY_TOKEN 生产为密文（create 时 AesGcmCrypto 加密），测试用 dev 密钥封真值。
  const seal = (plain: string): string => new AesGcmCrypto(config.fleet.encryptionKeys).encrypt(plain)

  // 确定性端口分配（DB port @unique，同文件内递增避免冲突）
  let nextPort = 19000

  async function seedContainer(name: string, ownerId: string, token: string, encrypted: boolean): Promise<void> {
    await ctx.prisma.container.create({
      data: {
        name,
        port: nextPort++,
        ownerId,
        token,
        tokenEncrypted: encrypted,
        homeDir: `/h/${name}`,
        image: 'img',
        status: 'running',
      },
    })
  }

  it('user 对自己的容器 → 返回解密 bootstrapToken（密文行）', async () => {
    const u = await seedUser(ctx.prisma, 'u-bt1', 'pw-bt1-secure')
    await seedContainer('own-c', u.id, seal('tok-own'), true)
    const l = await login(ctx.request, 'u-bt1', 'pw-bt1-secure')
    const r = await ctx.request.post('/api/v1/containers/own-c/bootstrap-token').set(bearer(l.access))
    expect(r.status).toBe(200)
    expect(r.body.code).toBe(0)
    expect(r.body.data.bootstrapToken).toBe('tok-own')
  })

  it('user 对他人容器与不存在 → 同码 20040 且响应字节级一致（防探测）', async () => {
    await seedUser(ctx.prisma, 'u-bt2', 'pw-bt2-secure')
    const b = await seedUser(ctx.prisma, 'u-bt3', 'pw-bt3-secure')
    await seedContainer('other-c', b.id, seal('tok-other'), true)
    const la = await login(ctx.request, 'u-bt2', 'pw-bt2-secure')
    const cross = await ctx.request.post('/api/v1/containers/other-c/bootstrap-token').set(bearer(la.access))
    const missing = await ctx.request.post('/api/v1/containers/ghost-c/bootstrap-token').set(bearer(la.access))
    expect(cross.status).toBe(200)
    expect(cross.body.code).toBe(20040)
    expect(missing.body.code).toBe(20040)
    expect(cross.body).toEqual(missing.body) // 「不存在 vs 越权」不分裂
  })

  it('admin 跨用户容器 → 放行', async () => {
    const u = await seedUser(ctx.prisma, 'u-bt4', 'pw-bt4-secure')
    await seedContainer('admin-c', u.id, seal('tok-adm'), true)
    await seedAdmin(ctx.prisma, 'adm-bt', 'pw-admbt-secure')
    const l = await login(ctx.request, 'adm-bt', 'pw-admbt-secure')
    const r = await ctx.request.post('/api/v1/containers/admin-c/bootstrap-token').set(bearer(l.access))
    expect(r.body.code).toBe(0)
    expect(r.body.data.bootstrapToken).toBe('tok-adm')
  })

  it('tokenEncrypted=false 遗留明文行 → 原样返回（不解密）', async () => {
    const u = await seedUser(ctx.prisma, 'u-bt5', 'pw-bt5-secure')
    await seedContainer('plain-c', u.id, 'plain-tok', false)
    const l = await login(ctx.request, 'u-bt5', 'pw-bt5-secure')
    const r = await ctx.request.post('/api/v1/containers/plain-c/bootstrap-token').set(bearer(l.access))
    expect(r.body.code).toBe(0)
    expect(r.body.data.bootstrapToken).toBe('plain-tok')
  })

  it('非法 name → 90002 + data.name（区别于 20040）', async () => {
    await seedUser(ctx.prisma, 'u-bt6', 'pw-bt6-secure')
    const l = await login(ctx.request, 'u-bt6', 'pw-bt6-secure')
    const r = await ctx.request.post('/api/v1/containers/INVALID_NAME/bootstrap-token').set(bearer(l.access))
    expect(r.body.code).toBe(90002)
    expect(r.body.data.name).toBeTruthy()
  })

  it('未认证 → 10001', async () => {
    const r = await ctx.request.post('/api/v1/containers/x/bootstrap-token')
    expect(r.body.code).toBe(10001)
  })
})
