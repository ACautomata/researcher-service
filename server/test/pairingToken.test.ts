// containers pairing deviceToken REST 测试（多容器配对 bug 修复 · 用户定案）。
// 根因：deviceToken 原存前端 localStorage，键 (clientId='webchat-ui', deviceId, role) 不含容器名 →
// 跨容器共用一条 token，容器 2 复用容器 1 的 token → 网关 AUTH_DEVICE_TOKEN_MISMATCH → 连接即停。
// 修复：token 上移服务端 DB（Pairing.deviceToken 密文列，按 containerId 一对一），前端改经
// GET/PUT …/pairing/token 读写——作用域解析按 URL 容器名，clientId 恒定也无妨（根因消除）。
// 覆盖：归属门（user 仅自己 / admin 放行 / 越权与不存在同码 20040 字节级一致）/ PUT 落密文（DB 不
// 落明文）/ GET 解密回明文 / 无 token → data.token=null（前端走 bootstrap + 自动配对）/ 非法 name →
// 90002 / 未认证 10001 / 跨容器 token 隔离（容器2 读不到容器1 的 token = 核心回归断言）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import { makeFleetTest } from './fleetTestUtils'
import { AesGcmCrypto } from '../src/crypto'
import { config } from '../src/config'

describe('containers pairing deviceToken REST（多容器配对 bug 修复）', () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestApp()
    const fl = makeFleetTest(ctx.prisma)
    const { createApp } = await import('../src/app')
    const supertest = (await import('supertest')).default
    const app = createApp({ prisma: ctx.prisma, orchestrator: fl.orch, runtime: fl.runtime })
    ctx.request = supertest(app) as unknown as TestContext['request']
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  let nextPort = 19100
  async function seedContainer(name: string, ownerId: string, status = 'running'): Promise<string> {
    const row = await ctx.prisma.container.create({
      data: {
        name,
        port: nextPort++,
        ownerId,
        token: 'sealed',
        homeDir: `/h/${name}`,
        image: 'img',
        status: status as 'running' | 'stopped',
      },
    })
    return row.id
  }

  const getToken = (access: string | undefined, name: string) =>
    ctx.request.get(`/api/v1/containers/${name}/pairing/token`).set(bearer(access))
  const putToken = (access: string | undefined, name: string, deviceToken: unknown) =>
    ctx.request.put(`/api/v1/containers/${name}/pairing/token`).set(bearer(access)).send({ deviceToken })

  it('PUT 存 token → DB 落密文（不落明文）+ GET 解密回明文', async () => {
    const u = await seedUser(ctx.prisma, 'u-tk1', 'pw-tk1-secure')
    const cid = await seedContainer('tok-c1', u.id)
    const l = await login(ctx.request, 'u-tk1', 'pw-tk1-secure')

    const put = await putToken(l.access, 'tok-c1', 'device-token-ABC')
    expect(put.status).toBe(200)
    expect(put.body.code).toBe(0)

    const row = await ctx.prisma.pairing.findUnique({ where: { containerId: cid } })
    expect(row).toBeTruthy()
    expect(row!.deviceToken).not.toBe('device-token-ABC') // DB 不落明文
    expect(row!.deviceToken).toMatch(/^v1:/) // 密文 sealed 格式
    expect(row!.deviceTokenEncrypted).toBe(true)

    const get = await getToken(l.access, 'tok-c1')
    expect(get.body.code).toBe(0)
    expect(get.body.data).toEqual({ token: 'device-token-ABC' }) // 解密回明文
  })

  it('核心回归：跨容器 token 隔离——容器2 读不到容器1 的 token', async () => {
    const u = await seedUser(ctx.prisma, 'u-tk2', 'pw-tk2-secure')
    await seedContainer('tok-alpha', u.id)
    await seedContainer('tok-beta', u.id)
    const l = await login(ctx.request, 'u-tk2', 'pw-tk2-secure')

    await putToken(l.access, 'tok-alpha', 'token-ALPHA')
    const betaGet = await getToken(l.access, 'tok-beta')
    // 容器 beta 从未配对 → token=null（前端走 bootstrap + 自动配对），绝不回容器 alpha 的 token
    expect(betaGet.body.data).toEqual({ token: null })
    const alphaGet = await getToken(l.access, 'tok-alpha')
    expect(alphaGet.body.data).toEqual({ token: 'token-ALPHA' })
  })

  it('无配对行 / 空 token → data.token=null', async () => {
    const u = await seedUser(ctx.prisma, 'u-tk3', 'pw-tk3-secure')
    await seedContainer('tok-empty', u.id)
    const l = await login(ctx.request, 'u-tk3', 'pw-tk3-secure')
    const r = await getToken(l.access, 'tok-empty')
    expect(r.body.code).toBe(0)
    expect(r.body.data).toEqual({ token: null })
  })

  it('PUT 覆盖旧 token（网关重置后重新配对落新 token）', async () => {
    const u = await seedUser(ctx.prisma, 'u-tk4', 'pw-tk4-secure')
    await seedContainer('tok-ow', u.id)
    const l = await login(ctx.request, 'u-tk4', 'pw-tk4-secure')
    await putToken(l.access, 'tok-ow', 'old-token')
    await putToken(l.access, 'tok-ow', 'new-token')
    const r = await getToken(l.access, 'tok-ow')
    expect(r.body.data).toEqual({ token: 'new-token' })
  })

  it('user 对他人容器 GET/PUT 与不存在 → 同码 20040 且字节级一致（防探测）', async () => {
    await seedUser(ctx.prisma, 'u-tk5', 'pw-tk5-secure')
    const b = await seedUser(ctx.prisma, 'u-tk6', 'pw-tk6-secure')
    await seedContainer('other-tok', b.id)
    const la = await login(ctx.request, 'u-tk5', 'pw-tk5-secure')
    const crossGet = await getToken(la.access, 'other-tok')
    const missingGet = await getToken(la.access, 'ghost-tok')
    expect(crossGet.body.code).toBe(20040)
    expect(missingGet.body.code).toBe(20040)
    expect(crossGet.body).toEqual(missingGet.body)
    const crossPut = await putToken(la.access, 'other-tok', 'x')
    expect(crossPut.body.code).toBe(20040)
  })

  it('admin 跨用户容器 → 放行 GET/PUT', async () => {
    const u = await seedUser(ctx.prisma, 'u-tk7', 'pw-tk7-secure')
    await seedContainer('adm-tok', u.id)
    await seedAdmin(ctx.prisma, 'adm-tk', 'pw-admtk-secure')
    const l = await login(ctx.request, 'adm-tk', 'pw-admtk-secure')
    const put = await putToken(l.access, 'adm-tok', 'adm-token')
    expect(put.body.code).toBe(0)
    const get = await getToken(l.access, 'adm-tok')
    expect(get.body.data).toEqual({ token: 'adm-token' })
  })

  it('非法容器 name → 90002 + data.name（区别于 20040）', async () => {
    await seedUser(ctx.prisma, 'u-tk8', 'pw-tk8-secure')
    const l = await login(ctx.request, 'u-tk8', 'pw-tk8-secure')
    const r = await getToken(l.access, 'INVALID_NAME')
    expect(r.body.code).toBe(90002)
    expect(r.body.data.name).toBeTruthy()
    const p = await putToken(l.access, 'INVALID_NAME', 'x')
    expect(p.body.code).toBe(90002)
  })

  it('PUT 非字符串 token → 90002', async () => {
    const u = await seedUser(ctx.prisma, 'u-tk9', 'pw-tk9-secure')
    await seedContainer('tok-badval', u.id)
    const l = await login(ctx.request, 'u-tk9', 'pw-tk9-secure')
    const r = await putToken(l.access, 'tok-badval', 123)
    expect(r.body.code).toBe(90002)
  })

  it('未认证 → 10001', async () => {
    // 不带 Authorization 头（bearer(undefined) 会 throw，未认证用例须裸调用——对齐 pairingApprove.test）
    expect((await ctx.request.get('/api/v1/containers/x/pairing/token')).body.code).toBe(10001)
    expect((await ctx.request.put('/api/v1/containers/x/pairing/token').send({ deviceToken: 't' })).body.code).toBe(10001)
  })

  it('密文可被 CREDENTIAL_ENCRYPTION_KEYS 解密（AesGcmCrypto 往返一致性）', async () => {
    const u = await seedUser(ctx.prisma, 'u-tk10', 'pw-tk10-secure')
    const cid = await seedContainer('tok-crypt', u.id)
    const l = await login(ctx.request, 'u-tk10', 'pw-tk10-secure')
    await putToken(l.access, 'tok-crypt', 'roundtrip-token')
    const row = await ctx.prisma.pairing.findUnique({ where: { containerId: cid } })
    const plain = new AesGcmCrypto(config.fleet.encryptionKeys).decrypt(row!.deviceToken)
    expect(plain).toBe('roundtrip-token')
  })
})
