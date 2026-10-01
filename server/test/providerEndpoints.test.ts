// provider_endpoints admin REST 测试（接缝 #2 信封级，#775 · 731 §3.1）。
//
// 覆盖：认证/admin 门（10001/10004）· CRUD wire · origin 唯一（含 NULL-port 等价语义应用层
// 查重 40041）· host 校验（大写/通配/URL 混入 90002）· DNS 私网拒绝（fake lookup）·
// allowPrivate 逃生门 · CRUD 同事务 config_meta bump · http scheme 生产门（NODE_ENV 翻转）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'

const privateLookup = async (host: string) =>
  (host === 'vllm.internal.example.com'
    ? [{ address: '192.168.1.20', family: 4 }]
    : [{ address: '203.0.113.10', family: 4 }]) as Array<{ address: string; family: number }>

describe('provider_endpoints admin REST（#775）', () => {
  let ctx: TestContext
  const base = '/api/v1/provider-endpoints'

  beforeAll(async () => {
    ctx = await setupTestApp({ providerEndpoints: { lookup: privateLookup } })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  const version = async (): Promise<number | null> =>
    (await ctx.prisma.configMeta.findUnique({ where: { id: 1 } }))?.version ?? null

  it('未认证 → 10001', async () => {
    const res = await ctx.request.get(base)
    expect(res.body.code).toBe(10001)
  })

  it('非 admin → 10004（user 角色拒绝）', async () => {
    await seedUser(ctx.prisma, 'peuser', 'pw-peuser-secure')
    const l = await login(ctx.request, 'peuser', 'pw-peuser-secure')
    for (const res of [
      await ctx.request.get(base).set(bearer(l.access)),
      await ctx.request.post(base).set(bearer(l.access)).send({ scheme: 'https', host: 'a.example.com' }),
      await ctx.request.delete(`${base}/x`).set(bearer(l.access)),
    ]) {
      expect(res.body.code).toBe(10004)
    }
  })

  it('admin GET 空列表 → []', async () => {
    await seedAdmin(ctx.prisma, 'peadmin', 'pw-peadmin-secure')
    const l = await login(ctx.request, 'peadmin', 'pw-peadmin-secure')
    const res = await ctx.request.get(base).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual([])
  })

  it('admin POST 创建 → 0 + wire 形状 + config_meta bump', async () => {
    const l = await login(ctx.request, 'peadmin', 'pw-peadmin-secure')
    const before = await version()
    const res = await ctx.request
      .post(base)
      .set(bearer(l.access))
      .send({ scheme: 'https', host: 'API.OpenAI.COM'.toLowerCase(), note: 'openai 官方' })
    expect(res.body.code).toBe(0)
    expect(res.body.data).toMatchObject({
      scheme: 'https',
      host: 'api.openai.com',
      port: null,
      note: 'openai 官方',
      created_by: expect.any(String),
    })
    const after = await version()
    expect(after).toBe(before === null ? 2 : before + 1)
  })

  it('POST 同 origin 重复 → 40041（unique）', async () => {
    const l = await login(ctx.request, 'peadmin', 'pw-peadmin-secure')
    const res = await ctx.request
      .post(base)
      .set(bearer(l.access))
      .send({ scheme: 'https', host: 'api.openai.com' })
    expect(res.body.code).toBe(40041)
  })

  it('POST NULL-port 等价冲突（同 scheme+host，条目 port:null vs 443）→ 40041（SQLite UNIQUE NULL 不判重的应用层兜底）', async () => {
    const l = await login(ctx.request, 'peadmin', 'pw-peadmin-secure')
    const res = await ctx.request
      .post(base)
      .set(bearer(l.access))
      .send({ scheme: 'https', host: 'api.openai.com', port: 443 })
    expect(res.body.code).toBe(40041)
  })

  it('POST 非显式端口的同 host 不同 port 可共存（443 条目 + 8443 条目）', async () => {
    const l = await login(ctx.request, 'peadmin', 'pw-peadmin-secure')
    const res = await ctx.request
      .post(base)
      .set(bearer(l.access))
      .send({ scheme: 'https', host: 'api.openai.com', port: 8443 })
    expect(res.body.code).toBe(0)
    const list = await ctx.request.get(base).set(bearer(l.access))
    expect(list.body.data.filter((e: { host: string }) => e.host === 'api.openai.com')).toHaveLength(2)
  })

  it('POST 非法 host（通配/URL 混入/带端口/空格）→ 90002 字段级；大写输入归一化为小写（同义条目折叠）', async () => {
    const l = await login(ctx.request, 'peadmin', 'pw-peadmin-secure')
    for (const host of ['*.example.com', 'https://x.example.com', 'x.example.com:8443', 'exa mple.com', '']) {
      const res = await ctx.request.post(base).set(bearer(l.access)).send({ scheme: 'https', host })
      expect(res.body.code, host).toBe(90002)
      expect(res.body.data).toHaveProperty('host')
    }
    // 大写 → zod toLowerCase 归一化（防 'API.x' 与 'api.x' 两行同义白名单）
    const upper = await ctx.request
      .post(base)
      .set(bearer(l.access))
      .send({ scheme: 'https', host: 'UPPER.Example.COM' })
    expect(upper.body.code).toBe(0)
    expect(upper.body.data.host).toBe('upper.example.com')
    // 归一化后再以小写重复建 → 40041（同 origin）
    const dup = await ctx.request
      .post(base)
      .set(bearer(l.access))
      .send({ scheme: 'https', host: 'upper.example.com' })
    expect(dup.body.code).toBe(40041)
  })

  it('POST DNS 私网解析（内网域名）→ 90002 字段级 host（防白名单条目做内网探测）', async () => {
    const l = await login(ctx.request, 'peadmin', 'pw-peadmin-secure')
    const res = await ctx.request
      .post(base)
      .set(bearer(l.access))
      .send({ scheme: 'https', host: 'vllm.internal.example.com' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data.host[0]).toContain('192.168.1.20')
  })

  it('POST scheme 非 https/http → 90002 字段级 scheme', async () => {
    const l = await login(ctx.request, 'peadmin', 'pw-peadmin-secure')
    const res = await ctx.request
      .post(base)
      .set(bearer(l.access))
      .send({ scheme: 'ftp', host: 'files.example.com' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('scheme')
  })

  it('POST http scheme 在生产门外（NODE_ENV=production）→ 90002；test 环境放行', async () => {
    const l = await login(ctx.request, 'peadmin', 'pw-peadmin-secure')
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const res = await ctx.request
        .post(base)
        .set(bearer(l.access))
        .send({ scheme: 'http', host: 'dev-vllm.example.com' })
      expect(res.body.code).toBe(90002)
      expect(res.body.data.scheme[0]).toContain('https')
    } finally {
      process.env.NODE_ENV = prev
    }
    const ok = await ctx.request
      .post(base)
      .set(bearer(l.access))
      .send({ scheme: 'http', host: 'dev-vllm.example.com', port: 8000 })
    expect(ok.body.code).toBe(0)
  })

  it('DELETE 存在 → 0 + bump；DELETE 不存在 → 40040；GET 读零 bump', async () => {
    const l = await login(ctx.request, 'peadmin', 'pw-peadmin-secure')
    const created = await ctx.request
      .post(base)
      .set(bearer(l.access))
      .send({ scheme: 'https', host: 'tmp.example.com' })
    const id = created.body.data.id as string
    await ctx.request.get(base).set(bearer(l.access))
    const before = await version()
    const del = await ctx.request.delete(`${base}/${id}`).set(bearer(l.access))
    expect(del.body.code).toBe(0)
    expect(await version()).toBe(before! + 1)
    const miss = await ctx.request.delete(`${base}/${id}`).set(bearer(l.access))
    expect(miss.body.code).toBe(40040)
  })

  it('删除被引用端点不级联 provider 行（双层校验兜底：下个 run 复验 40042）', async () => {
    const l = await login(ctx.request, 'peadmin', 'pw-peadmin-secure')
    const created = await ctx.request
      .post(base)
      .set(bearer(l.access))
      .send({ scheme: 'https', host: 'doomed.example.com' })
    const id = created.body.data.id as string
    // 直接落一行引用该端点的 provider（owner 维度与端点正交，删除端点不影响行）
    const u = await seedUser(ctx.prisma, 'peref', 'pw-peref-secure')
    await ctx.prisma.modelProvider.create({
      data: {
        ownerId: u.id,
        providerId: 'doomed',
        lcProvider: 'openai',
        baseUrl: 'https://doomed.example.com/v1',
        credentialEnvId: 'LLM_API_KEY',
        authHeader: true,
        modelsJson: '[]',
      },
    })
    const del = await ctx.request.delete(`${base}/${id}`).set(bearer(l.access))
    expect(del.body.code).toBe(0)
    expect(await ctx.prisma.modelProvider.count({ where: { ownerId: u.id, providerId: 'doomed' } })).toBe(1)
  })
})

// allowPrivate 逃生门：私网解析 host + 开关开 → 放行（dev 自建 vLLM 场景）。
describe('provider_endpoints allowPrivate 逃生门（#775）', () => {
  let ctx: TestContext
  const base = '/api/v1/provider-endpoints'

  beforeAll(async () => {
    ctx = await setupTestApp({
      providerEndpoints: { lookup: privateLookup, allowPrivate: true },
    })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('allowPrivate=true → 内网域名端点放行', async () => {
    await seedAdmin(ctx.prisma, 'peadmin2', 'pw-peadmin2-secure')
    const l = await login(ctx.request, 'peadmin2', 'pw-peadmin2-secure')
    const res = await ctx.request
      .post(base)
      .set(bearer(l.access))
      .send({ scheme: 'https', host: 'vllm.internal.example.com', note: '自建 vLLM' })
    expect(res.body.code).toBe(0)
  })
})
