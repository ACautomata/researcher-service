// models REST 契约测试（#336 → #775 事务简化形态 · 接缝 #2 信封 + 归属前置 + 白名单第一层）。
// 端点 /api/v1/containers/<name>/models/providers[/<pid>]；snake_case wire（平移 Django + 前端）。
//
// #775（731 §4/§5.1）：写盘链（configWriter/configBuilder/写锁/reconcile）整段退役——DB 即盘，
// CRUD 同事务 bump config_meta.version（热生效信号）；新增白名单第一层校验（origin 精确匹配 +
// DNS 私网/环回拒绝，90002 字段明细）。DNS 解析经 ModelsRouterDeps.resolveDns 注入 fake
//（S1 接缝——测试不发真 DNS 查询）；白名单条目直接种 provider_endpoints 行。
//
// 验收映射：#775 —— provider CRUD 热生效信号（version bump，配置变更下个 run 生效的读侧验收
// 在 providerRegistry.test.ts）/ 白名单第一层（非法 URL / 未命中 / DNS 私网 / 解析失败 → 90002）
// / 既有契约保持（40040 防探测同码 / 40041 唯一冲突 / 20043 生命周期忙 / 90002 字段明细 /
// 凭证零落盘——响应侧无明文）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import type { ContainerStatus } from '../src/generated/prisma/client'
import { ModelProviderService, type ModelProviderWriteInput } from '../src/models/service'
import type { DnsLookup } from '../src/models/endpointAllowlist'

let seq = 0

// fake DNS（S1 接缝）：host → 解析地址；未登记 host 视为 NXDOMAIN（解析失败 fail-closed 路径）。
// 地址用 RFC 5737 测试网段（203.0.113/24）代表公网。
const DNS_MAP: Record<string, string[]> = {
  'open.bigmodel.cn': ['203.0.113.10'],
  'api.minimaxi.com': ['203.0.113.20'],
  'private.example.com': ['10.1.2.3'],
  'loopback.example.com': ['127.0.0.1'],
  'mapped.example.com': ['::ffff:10.0.0.5'], // IPv4-mapped 形态伪装私网
}
const resolveDns: DnsLookup = async (host) => {
  const addrs = DNS_MAP[host]
  if (!addrs) throw new Error(`NXDOMAIN: ${host}`)
  return addrs
}

const VALID = {
  provider_id: 'my-openai',
  api: 'openai-completions',
  base_url: 'https://open.bigmodel.cn/api/paas/v4',
  api_key_env_id: 'LLM_API_KEY',
  auth_header: true,
  models: [
    {
      id: 'glm-4-plus',
      name: 'GLM-4 Plus',
      reasoning: false,
      input: ['text'],
      contextWindow: 131072,
      maxTokens: 8192,
    },
  ],
}

describe('models REST（接缝 #2 + #775 简化事务 + 白名单第一层）', () => {
  let ctx: TestContext
  const providersOf = (name: string): string => `/api/v1/containers/${name}/models/providers`
  const providerOf = (name: string, pid: string): string => `${providersOf(name)}/${pid}`

  beforeAll(async () => {
    ctx = await setupTestApp({ models: { resolveDns } })
    // 镜像生产库基线：db:apply/upgrade 经 incremental-schema 种 config_meta 单行（id=1, version=1）。
    // init.sql 只建表不种子（种子归增量路径），测试库在此对齐。
    await ctx.prisma.configMeta.create({ data: { id: 1, version: 1 } })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  // 每容器独立 name/port（name/port 全局唯一，跨测试不得复用）。
  async function seedContainer(ownerId: string, status: ContainerStatus = 'running'): Promise<{ name: string; id: string }> {
    seq += 1
    const name = `pmod${seq}`
    const row = await ctx.prisma.container.create({
      data: {
        name,
        port: 19000 + seq,
        ownerId,
        token: 't',
        homeDir: '/h',
        image: 'img',
        status,
      },
    })
    return { name, id: row.id }
  }

  async function seedEndpoint(host: string, scheme = 'https', port: number | null = null): Promise<void> {
    await ctx.prisma.providerEndpoint.create({ data: { scheme, host, port, createdBy: '' } })
  }

  async function configVersion(): Promise<number> {
    const meta = await ctx.prisma.configMeta.findUnique({ where: { id: 1 } })
    return meta?.version ?? 0
  }

  // ---------------------------- 认证 / name / 容器归属（公共前置）----------------------------

  it('未认证 → 10001', async () => {
    const res = await ctx.request.get(providersOf('pmod1'))
    expect(res.body.code).toBe(10001)
  })

  it('name 非法 → 90002 + data.name（大写/非法字符）', async () => {
    await seedUser(ctx.prisma, 'minv', 'pw-minv-secure')
    const l = await login(ctx.request, 'minv', 'pw-minv-secure')
    const res = await ctx.request.get(providersOf('Bad_Name')).set(bearer(l.access))
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('name')
  })

  it('容器不存在 → 20040（空 data）', async () => {
    await seedUser(ctx.prisma, 'mnotf', 'pw-mnotf-secure')
    const l = await login(ctx.request, 'mnotf', 'pw-mnotf-secure')
    const res = await ctx.request.get(providersOf('nope')).set(bearer(l.access))
    expect(res.body.code).toBe(20040)
    expect(res.body.data).toBeNull()
  })

  it('user 越权访问他人容器 → 20040，与「不存在」同码同文案同空 data（防探测）', async () => {
    const u = await seedUser(ctx.prisma, 'mowner', 'pw-mowner-secure')
    await seedUser(ctx.prisma, 'mvoy', 'pw-mvoy-secure')
    const { name } = await seedContainer(u.id)
    const lv = await login(ctx.request, 'mvoy', 'pw-mvoy-secure')
    const res = await ctx.request.get(providersOf(name)).set(bearer(lv.access))
    expect(res.body).toEqual({ code: 20040, message: expect.any(String), data: null })
  })

  it('admin 可跨用户访问全部容器（归属对偶：放行）', async () => {
    const u = await seedUser(ctx.prisma, 'madmt', 'pw-madmt-secure')
    const { name } = await seedContainer(u.id)
    await seedAdmin(ctx.prisma, 'madmx', 'pw-madmx-secure')
    const la = await login(ctx.request, 'madmx', 'pw-madmx-secure')
    const res = await ctx.request.get(providersOf(name)).set(bearer(la.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual([])
  })

  it('顺序陷阱：越权 + 非法 body → 20040（容器校验先于 body）；非法 name → 90002', async () => {
    const u = await seedUser(ctx.prisma, 'mord', 'pw-mord-secure')
    await seedUser(ctx.prisma, 'mordv', 'pw-mordv-secure')
    const { name } = await seedContainer(u.id)
    const lv = await login(ctx.request, 'mordv', 'pw-mordv-secure')
    const r1 = await ctx.request
      .post(providersOf(name))
      .set(bearer(lv.access))
      .send({ ...VALID, provider_id: 'Bad_Format' })
    expect(r1.body.code).toBe(20040) // 越权优先，不透 body 校验（防探测）
    const r2 = await ctx.request
      .post(providersOf('Bad_Name'))
      .set(bearer(lv.access))
      .send({ ...VALID, provider_id: 'Bad_Format' })
    expect(r2.body.code).toBe(90002) // name 非法优先
    expect(r2.body.data).toHaveProperty('name')
  })

  it('creating 容器 POST → 20043；GET 只读放行', async () => {
    const u = await seedUser(ctx.prisma, 'mcreat', 'pw-mcreat-secure')
    const { name } = await seedContainer(u.id, 'creating')
    const l = await login(ctx.request, 'mcreat', 'pw-mcreat-secure')
    const res = await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    expect(res.body.code).toBe(20043)
    const rget = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(rget.body.code).toBe(0)
  })

  it('removing 容器 POST/PUT/DELETE → 20043（生命周期忙拒写）；GET 只读放行', async () => {
    // #775 写盘链退役后原始竞态理由消失，检查保留（REST 契约稳定语义，service.ts 注释）。
    const u = await seedUser(ctx.prisma, 'mremov', 'pw-mremov-secure')
    const { name } = await seedContainer(u.id, 'removing')
    const l = await login(ctx.request, 'mremov', 'pw-mremov-secure')
    for (const method of ['post', 'put', 'delete'] as const) {
      const req = method === 'post'
        ? ctx.request.post(providersOf(name)).send(VALID)
        : method === 'put'
          ? ctx.request.put(providerOf(name, 'my-openai')).send(VALID)
          : ctx.request.delete(providerOf(name, 'my-openai'))
      const res = await req.set(bearer(l.access))
      expect(res.body.code).toBe(20043)
    }
    const rget = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(rget.body.code).toBe(0)
  })

  it('事务内状态谓词：removing 容器直调 service 拒 20043（路由快照外的 TOCTOU 防线）', async () => {
    const u = await seedUser(ctx.prisma, 'mtxw', 'pw-mtxw-secure')
    const { name } = await seedContainer(u.id, 'removing')
    const svc = new ModelProviderService(ctx.prisma, resolveDns)
    const inst = (await ctx.prisma.container.findUnique({ where: { name } }))!
    await seedEndpoint('open.bigmodel.cn')
    const input: ModelProviderWriteInput = {
      providerId: 'my-openai',
      api: 'openai-completions',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKeyEnvId: 'LLM_API_KEY',
      authHeader: true,
      models: [{ id: 'glm-4-plus' }],
    }
    await expect(svc.create(inst, input)).rejects.toMatchObject({ code: 20043 })
  })

  // ---------------------------- 列表 / 新建 ----------------------------

  it('list 空 → []', async () => {
    const u = await seedUser(ctx.prisma, 'mempty', 'pw-mempty-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mempty', 'pw-mempty-secure')
    const res = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual([])
  })

  it('create 返回 provider（snake_case wire）+ bump config_meta.version（热生效信号）', async () => {
    await seedEndpoint('open.bigmodel.cn')
    const u = await seedUser(ctx.prisma, 'mcreate', 'pw-mcreate-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mcreate', 'pw-mcreate-secure')
    const before = await configVersion()
    const res = await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    expect(res.body.code).toBe(0)
    const data = res.body.data
    expect(data.provider_id).toBe('my-openai')
    expect(data.api).toBe('openai-completions')
    expect(data.base_url).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(data.api_key_env_id).toBe('LLM_API_KEY') // 仅 env id（marker）
    expect(data.auth_header).toBe(true)
    expect(data.models).toEqual(VALID.models)
    expect(typeof data.id).toBe('string')
    expect(typeof data.created_at).toBe('string')
    expect(data).not.toHaveProperty('api_key') // 无明文字段
    // 热生效信号：CRUD 同事务 version +1（runner 下个 run 读版本判等重载，读侧验收见
    // providerRegistry.test.ts）
    expect(await configVersion()).toBe(before + 1)
  })

  it('list 显示已建 provider', async () => {
    await seedEndpoint('open.bigmodel.cn')
    const u = await seedUser(ctx.prisma, 'mlist', 'pw-mlist-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mlist', 'pw-mlist-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    const res = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].provider_id).toBe('my-openai')
  })

  it('create 非法 body → 90002 + 字段明细', async () => {
    await seedEndpoint('open.bigmodel.cn')
    const u = await seedUser(ctx.prisma, 'minval', 'pw-minval-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'minval', 'pw-minval-secure')
    const before = await configVersion()
    const r1 = await ctx.request.post(providersOf(name)).set(bearer(l.access)).send({ ...VALID, api: 'bogus' })
    expect(r1.body.code).toBe(90002)
    expect(r1.body.data).toHaveProperty('api')
    const r2 = await ctx.request
      .post(providersOf(name))
      .set(bearer(l.access))
      .send({ ...VALID, provider_id: 'Bad_Format' })
    expect(r2.body.code).toBe(90002)
    expect(r2.body.data).toHaveProperty('provider_id')
    const r3 = await ctx.request.post(providersOf(name)).set(bearer(l.access)).send({ ...VALID, models: [] })
    expect(r3.body.code).toBe(90002)
    expect(r3.body.data).toHaveProperty('models')
    // base_url 纯空白语义为空 → 90002 + data.base_url（trim 后 min(1) 拒绝）
    const r5 = await ctx.request
      .post(providersOf(name))
      .set(bearer(l.access))
      .send({ ...VALID, base_url: '   ' })
    expect(r5.body.code).toBe(90002)
    expect(r5.body.data).toHaveProperty('base_url')
    // input 模态限 r28 §1.2 枚举
    const r6 = await ctx.request
      .post(providersOf(name))
      .set(bearer(l.access))
      .send({ ...VALID, models: [{ id: 'm', name: 'M', input: ['bogus'] }] })
    expect(r6.body.code).toBe(90002)
    expect(r6.body.data).toHaveProperty('models')
    // 同 provider 内重复 model id
    const r7 = await ctx.request
      .post(providersOf(name))
      .set(bearer(l.access))
      .send({ ...VALID, models: [{ id: 'm', name: 'A' }, { id: 'm', name: 'B' }] })
    expect(r7.body.code).toBe(90002)
    expect(r7.body.data).toHaveProperty('models')
    // 校验失败不入库、不 bump 版本
    expect(await configVersion()).toBe(before)
    const list = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(list.body.data).toEqual([])
  })

  it('api_key_env_id 非法格式 / 不在允许集合 → 90002 + data.api_key_env_id', async () => {
    await seedEndpoint('open.bigmodel.cn')
    const u = await seedUser(ctx.prisma, 'menv', 'pw-menv-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'menv', 'pw-menv-secure')
    const r1 = await ctx.request
      .post(providersOf(name))
      .set(bearer(l.access))
      .send({ ...VALID, api_key_env_id: 'lower_key' })
    expect(r1.body.code).toBe(90002)
    expect(r1.body.data.api_key_env_id).toBeDefined()
    const r2 = await ctx.request
      .post(providersOf(name))
      .set(bearer(l.access))
      .send({ ...VALID, api_key_env_id: 'ZHIPU_API_KEY' })
    expect(r2.body.code).toBe(90002)
    expect(r2.body.data.api_key_env_id).toBeDefined()
  })

  it('create 撞同 owner 既有 provider_id → 40041（unique 约束），不 bump 版本', async () => {
    await seedEndpoint('open.bigmodel.cn')
    const u = await seedUser(ctx.prisma, 'mdup', 'pw-mdup-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mdup', 'pw-mdup-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    const before = await configVersion()
    const res = await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    expect(res.body.code).toBe(40041)
    expect(await configVersion()).toBe(before) // 失败 mutation 无热生效信号
  })

  it('create 撞不存在容器 → 20040（容器门先于 body 校验）', async () => {
    await seedUser(ctx.prisma, 'mmiss', 'pw-mmiss-secure')
    const l = await login(ctx.request, 'mmiss', 'pw-mmiss-secure')
    const res = await ctx.request.post(providersOf('nope')).set(bearer(l.access)).send(VALID)
    expect(res.body.code).toBe(20040)
  })

  // ---------------------------- 白名单第一层（#775 · 731 §5.1）----------------------------

  it('base_url 非法 URL 形态（无 scheme）→ 90002 + data.base_url', async () => {
    await seedEndpoint('open.bigmodel.cn')
    const u = await seedUser(ctx.prisma, 'mwurl', 'pw-mwurl-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mwurl', 'pw-mwurl-secure')
    const res = await ctx.request
      .post(providersOf(name))
      .set(bearer(l.access))
      .send({ ...VALID, base_url: 'open.bigmodel.cn/api/paas/v4' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data.base_url).toBeDefined()
  })

  it('base_url origin 未命中白名单 → 90002 + data.base_url（90003 不再出自 models CRUD）', async () => {
    await seedEndpoint('open.bigmodel.cn')
    const u = await seedUser(ctx.prisma, 'mwl', 'pw-mwl-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mwl', 'pw-mwl-secure')
    // 域名合法可解析，但 origin 不在 provider_endpoints
    const res = await ctx.request
      .post(providersOf(name))
      .set(bearer(l.access))
      .send({ ...VALID, base_url: 'https://api.minimaxi.com/anthropic' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data.base_url).toBeDefined()
    expect(res.body.data.base_url[0]).toMatch(/白名单/)
    // 判定顺序：白名单未命中不发 DNS 查询的副作用无观察面——仅验结果
  })

  it('base_url 端口不匹配白名单条目（origin 精确匹配含端口）→ 90002', async () => {
    await seedEndpoint('open.bigmodel.cn') // port NULL = 默认 443
    const u = await seedUser(ctx.prisma, 'mwport', 'pw-mwport-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mwport', 'pw-mwport-secure')
    const res = await ctx.request
      .post(providersOf(name))
      .set(bearer(l.access))
      .send({ ...VALID, base_url: 'https://open.bigmodel.cn:8443/api/paas/v4' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data.base_url).toBeDefined()
  })

  it('DNS 解析到私网/环回 → 90002（含 IPv4-mapped IPv6 伪装形态）', async () => {
    await seedEndpoint('private.example.com')
    await seedEndpoint('loopback.example.com')
    await seedEndpoint('mapped.example.com')
    const u = await seedUser(ctx.prisma, 'mwpriv', 'pw-mwpriv-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mwpriv', 'pw-mwpriv-secure')
    for (const [host, snippet] of [
      ['private.example.com', /内网/],
      ['loopback.example.com', /内网|环回/],
      ['mapped.example.com', /内网/],
    ] as const) {
      const res = await ctx.request
        .post(providersOf(name))
        .set(bearer(l.access))
        .send({ ...VALID, base_url: `https://${host}/v1` })
      expect(res.body.code).toBe(90002)
      expect(res.body.data.base_url[0]).toMatch(snippet)
    }
    const list = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(list.body.data).toEqual([]) // 拒绝的不入库
  })

  it('DNS 解析失败（NXDOMAIN）→ 90002 fail-closed', async () => {
    await seedEndpoint('ghost.example.com')
    const u = await seedUser(ctx.prisma, 'mwnx', 'pw-mwnx-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mwnx', 'pw-mwnx-secure')
    const res = await ctx.request
      .post(providersOf(name))
      .set(bearer(l.access))
      .send({ ...VALID, base_url: 'https://ghost.example.com/v1' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data.base_url[0]).toMatch(/无法解析/)
  })

  it('白名单校验先于唯一约束：撞名 + 未命中白名单 → 90002（白名单在事务前）', async () => {
    await seedEndpoint('open.bigmodel.cn')
    const u = await seedUser(ctx.prisma, 'mworder', 'pw-mworder-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mworder', 'pw-mworder-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    const res = await ctx.request
      .post(providersOf(name))
      .set(bearer(l.access))
      .send({ ...VALID, base_url: 'https://api.minimaxi.com/anthropic' }) // 同 pid + 白名单未命中
    expect(res.body.code).toBe(90002) // 非 40041——白名单校验在事务（唯一约束）之前
  })

  // ---------------------------- 回读 / 改 / 删 ----------------------------

  it('get 单条 provider', async () => {
    await seedEndpoint('open.bigmodel.cn')
    const u = await seedUser(ctx.prisma, 'mget', 'pw-mget-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mget', 'pw-mget-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    const res = await ctx.request.get(providerOf(name, 'my-openai')).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data.provider_id).toBe('my-openai')
  })

  it('get 未知 provider → 40040（同码防探测，data null）', async () => {
    const u = await seedUser(ctx.prisma, 'mgetnf', 'pw-mgetnf-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mgetnf', 'pw-mgetnf-secure')
    const res = await ctx.request.get(providerOf(name, 'nope')).set(bearer(l.access))
    expect(res.body).toEqual({ code: 40040, message: expect.any(String), data: null })
  })

  it('put 未知 provider → 40040（P2025 转译）', async () => {
    await seedEndpoint('open.bigmodel.cn')
    const u = await seedUser(ctx.prisma, 'mputnf', 'pw-mputnf-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mputnf', 'pw-mputnf-secure')
    const res = await ctx.request.put(providerOf(name, 'nope')).set(bearer(l.access)).send(VALID)
    expect(res.body).toEqual({ code: 40040, message: expect.any(String), data: null })
  })

  it('put 改 base_url + models → 视图更新 + bump 版本', async () => {
    await seedEndpoint('open.bigmodel.cn')
    await seedEndpoint('api.minimaxi.com')
    const u = await seedUser(ctx.prisma, 'mput', 'pw-mput-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mput', 'pw-mput-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    const update = {
      ...VALID,
      base_url: 'https://api.minimaxi.com/anthropic',
      models: [{ id: 'MiniMax-M3', name: 'MiniMax M3' }],
    }
    const before = await configVersion()
    const res = await ctx.request.put(providerOf(name, 'my-openai')).set(bearer(l.access)).send(update)
    expect(res.body.code).toBe(0)
    expect(res.body.data.base_url).toBe('https://api.minimaxi.com/anthropic')
    expect(await configVersion()).toBe(before + 1)
  })

  it('put 改 provider_id（视图层面）', async () => {
    await seedEndpoint('open.bigmodel.cn')
    const u = await seedUser(ctx.prisma, 'mputid', 'pw-mputid-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mputid', 'pw-mputid-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    const update = { ...VALID, provider_id: 'renamed', models: [{ id: 'g', name: 'G' }] }
    const res = await ctx.request.put(providerOf(name, 'my-openai')).set(bearer(l.access)).send(update)
    expect(res.body.code).toBe(0)
    expect(res.body.data.provider_id).toBe('renamed')
    const list = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0].provider_id).toBe('renamed')
  })

  it('put 撞同 owner 既有 provider_id → 40041（非裸 500）', async () => {
    await seedEndpoint('open.bigmodel.cn')
    const u = await seedUser(ctx.prisma, 'mputcol', 'pw-mputcol-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mputcol', 'pw-mputcol-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID) // my-openai
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send({ ...VALID, provider_id: 'backup' })
    const collide = { ...VALID, provider_id: 'backup' } // 想把 my-openai 改成 backup
    const res = await ctx.request.put(providerOf(name, 'my-openai')).set(bearer(l.access)).send(collide)
    expect(res.body.code).toBe(40041)
  })

  it('delete 删 provider → 列表清空 + bump 版本', async () => {
    await seedEndpoint('open.bigmodel.cn')
    const u = await seedUser(ctx.prisma, 'mdel', 'pw-mdel-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mdel', 'pw-mdel-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    const before = await configVersion()
    const res = await ctx.request.delete(providerOf(name, 'my-openai')).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data).toBeNull()
    const list = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(list.body.data).toEqual([])
    expect(await configVersion()).toBe(before + 1)
  })

  it('delete 未知 provider → 40040', async () => {
    const u = await seedUser(ctx.prisma, 'mdelnf', 'pw-mdelnf-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mdelnf', 'pw-mdelnf-secure')
    const res = await ctx.request.delete(providerOf(name, 'nope')).set(bearer(l.access))
    expect(res.body.code).toBe(40040)
  })

  it('两 provider：list 按 createdAt 升序（fallback 链序由 runner 从快照派生，#777）', async () => {
    await seedEndpoint('open.bigmodel.cn')
    const u = await seedUser(ctx.prisma, 'mtwo', 'pw-mtwo-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mtwo', 'pw-mtwo-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    await ctx.request
      .post(providersOf(name))
      .set(bearer(l.access))
      .send({ ...VALID, provider_id: 'backup', api: 'anthropic-messages', models: [{ id: 'm', name: 'M' }] })
    const list = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(list.body.data.map((p: { provider_id: string }) => p.provider_id)).toEqual(['my-openai', 'backup'])
  })

  // ---------------------------- 凭证零落盘（响应侧）----------------------------

  it('凭证零落盘：响应体无 apiKey 明文（仅 env marker）', async () => {
    await seedEndpoint('open.bigmodel.cn')
    const u = await seedUser(ctx.prisma, 'mzero', 'pw-mzero-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mzero', 'pw-mzero-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    const listRes = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(listRes.body.data[0]).not.toHaveProperty('api_key')
    expect(listRes.body.data[0].api_key_env_id).toBe('LLM_API_KEY')
    const getRes = await ctx.request.get(providerOf(name, 'my-openai')).set(bearer(l.access))
    expect(getRes.body.data).not.toHaveProperty('api_key')
    expect(getRes.body.data.api_key_env_id).toBe('LLM_API_KEY')
  })

  // ---------------------------- model 条目形状（保留校验）----------------------------

  it('model 条目字段类型非法（name 为对象）→ 90002', async () => {
    await seedEndpoint('open.bigmodel.cn')
    const u = await seedUser(ctx.prisma, 'mbadmod', 'pw-mbadmod-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mbadmod', 'pw-mbadmod-secure')
    const bad = { ...VALID, models: [{ id: 'm', name: {} }] }
    const res = await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(bad)
    expect(res.body.code).toBe(90002)
    const list = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(list.body.data).toEqual([]) // 校验拒绝不入库
  })
})
