// models REST 契约测试（#336 · 接缝 #2 信封 + 归属前置；#775 事务简化 + 白名单第一层；
// #857 归属门改挂 ownerId：端点 /api/v1/models/providers[/<pid>]，owner 直取认证身份，
// 路由层零容器行查询——容器不存在/越权 20040 与 creating/removing 拒写 20043 随耦合移除）。
// snake_case wire（平移 Django + 前端）。
//
// #775 后事务语义：DB mutation + config_meta version bump（热生效信号）——写盘/reconcile/
// 写盘回滚（90003）整面退役（LLM 消费方换轨 runner，写盘链已随 T0 #801 清退）。
// 白名单第一层（731 §5.1）：origin 精确匹配 provider_endpoints + DNS 私网拒绝 →
// 90002 字段级 base_url；lookup 经 deps 注入 fake（零网络）。
//
// 验收映射：#336 —— 信封 + provider_id 撞 40041 / 越权与不存在同码 40040 /
// 凭证零落盘 / api_key_env_id 非法 90002；#775 —— CRUD 同事务 version bump /
// 白名单未命中与 DNS 私网 90002 字段级 / allowPrivate 逃生门；#857 —— owner 级路由
// （跨用户 pid 探测同码 40040 防探测）/ admin 亦只操作本人配置面。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import { ModelProviderService, type ModelProviderWriteInput } from '../src/models/service'

// fake DNS：默认全部解析到公网地址；可切换为私网以测拒绝（零网络）。
const publicLookup = async () => [{ address: '203.0.113.10', family: 4 }] as const
const privateLookup = async () => [{ address: '10.6.6.6', family: 4 }] as const

// owner 级集合面（#857；三个 describe 共用一份，免逐块重定义）
const PROVIDERS_PATH = '/api/v1/models/providers'

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

describe('models REST（接缝 #2 + #336 + #775 新事务 + #857 owner 级路由）', () => {
  let ctx: TestContext
  const providerOf = (pid: string): string => `${PROVIDERS_PATH}/${pid}`
  const configVersion = async (): Promise<number | null> => {
    const row = await ctx.prisma.configMeta.findUnique({ where: { id: 1 } })
    return row?.version ?? null
  }

  beforeAll(async () => {
    ctx = await setupTestApp({ models: { lookup: publicLookup as never } })
    // 白名单种子（测试库走 init.sql-only，无 #803 增量 seed——自种两条）
    await ctx.prisma.providerEndpoint.create({
      data: { id: 'ep-bigmodel', scheme: 'https', host: 'open.bigmodel.cn', port: null, note: 'test', createdBy: 'test' },
    })
    await ctx.prisma.providerEndpoint.create({
      data: { id: 'ep-minimax', scheme: 'https', host: 'api.minimaxi.com', port: null, note: 'test', createdBy: 'test' },
    })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  // ---------------------------- 认证 / owner 级归属（#857 公共前置）----------------------------

  it('未认证 → 10001', async () => {
    const res = await ctx.request.get(PROVIDERS_PATH)
    expect(res.body.code).toBe(10001)
  })

  it('旧容器前缀路径 → 90005（路由下线，#857）', async () => {
    await seedUser(ctx.prisma, 'mleg', 'pw-mleg-secure')
    const l = await login(ctx.request, 'mleg', 'pw-mleg-secure')
    const res = await ctx.request.get('/api/v1/containers/legacy/models/providers').set(bearer(l.access))
    expect(res.body.code).toBe(90005)
  })

  it('list 恒为本人的配置面（owner 直取认证身份）：他人 provider 不可见', async () => {
    await seedUser(ctx.prisma, 'mown', 'pw-mown-secure')
    await seedUser(ctx.prisma, 'mother', 'pw-mother-secure')
    const la = await login(ctx.request, 'mown', 'pw-mown-secure')
    await ctx.request.post(PROVIDERS_PATH).set(bearer(la.access)).send(VALID)
    const lb = await login(ctx.request, 'mother', 'pw-mother-secure')
    const res = await ctx.request.get(PROVIDERS_PATH).set(bearer(lb.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual([])
  })

  it('admin 亦只操作本人配置面（owner 级无跨用户覆写面；对齐 sessions 先例）', async () => {
    await seedUser(ctx.prisma, 'madmt', 'pw-madmt-secure')
    const lu = await login(ctx.request, 'madmt', 'pw-madmt-secure')
    await ctx.request.post(PROVIDERS_PATH).set(bearer(lu.access)).send(VALID)
    await seedAdmin(ctx.prisma, 'madmx', 'pw-madmx-secure')
    const la = await login(ctx.request, 'madmx', 'pw-madmx-secure')
    const res = await ctx.request.get(PROVIDERS_PATH).set(bearer(la.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual([])
    // admin 跨用户探测他人 pid → 40040（同码防探测）
    const r2 = await ctx.request.get(providerOf('my-openai')).set(bearer(la.access))
    expect(r2.body).toEqual({ code: 40040, message: expect.any(String), data: null })
  })

  it('越权探测他人 pid：get/put/delete 同码 40040（不存在 vs 越权防探测不弱化，#857）', async () => {
    await seedUser(ctx.prisma, 'mord', 'pw-mord-secure')
    await seedUser(ctx.prisma, 'mordv', 'pw-mordv-secure')
    const la = await login(ctx.request, 'mord', 'pw-mord-secure')
    await ctx.request.post(PROVIDERS_PATH).set(bearer(la.access)).send(VALID)
    const lv = await login(ctx.request, 'mordv', 'pw-mordv-secure')
    const r1 = await ctx.request.get(providerOf('my-openai')).set(bearer(lv.access))
    expect(r1.body).toEqual({ code: 40040, message: expect.any(String), data: null })
    const r2 = await ctx.request.put(providerOf('my-openai')).set(bearer(lv.access)).send(VALID)
    expect(r2.body.code).toBe(40040)
    const r3 = await ctx.request.delete(providerOf('my-openai')).set(bearer(lv.access))
    expect(r3.body.code).toBe(40040)
    // 越权者建同行 pid 不冲突（owner 隔离）：其名下独立配置面
    const r4 = await ctx.request.post(PROVIDERS_PATH).set(bearer(lv.access)).send(VALID)
    expect(r4.body.code).toBe(0)
  })

  it('service 直调面：ownerId 即操作主体（#857 服务签名 ownerId 标量化）', async () => {
    const u = await seedUser(ctx.prisma, 'msvc', 'pw-msvc-secure')
    const svc = new ModelProviderService(ctx.prisma)
    const input: ModelProviderWriteInput = {
      providerId: 'svc-openai',
      api: 'openai-completions',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKeyEnvId: 'LLM_API_KEY',
      authHeader: true,
      models: VALID.models,
    }
    const created = await svc.create(u.id, input)
    expect(created.provider_id).toBe('svc-openai')
    // 他人 ownerId 读不到该行 → 40040
    await expect(svc.get('no-such-owner', 'svc-openai')).rejects.toMatchObject({ code: 40040 })
  })

  // ---------------------------- CRUD wire 契约（#336 保留面）----------------------------

  it('create 返回 provider（snake_case wire）', async () => {
    await seedUser(ctx.prisma, mcName('wire'), 'pw-wire-secure')
    const l = await login(ctx.request, mcName('wire'), 'pw-wire-secure')
    const res = await ctx.request.post(PROVIDERS_PATH).set(bearer(l.access)).send(VALID)
    expect(res.body.code).toBe(0)
    expect(res.body.data).toMatchObject({
      provider_id: 'my-openai',
      api: 'openai-completions',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      api_key_env_id: 'LLM_API_KEY',
      auth_header: true,
      models: [expect.objectContaining({ id: 'glm-4-plus' })],
    })
    expect(res.body.data.created_at).toEqual(expect.any(String))
  })

  it('list 显示已建 provider（owner 级单一配置面，#857：同 owner 不随容器维度分裂）', async () => {
    await seedUser(ctx.prisma, mcName('list'), 'pw-list-secure')
    const l = await login(ctx.request, mcName('list'), 'pw-list-secure')
    await ctx.request.post(PROVIDERS_PATH).set(bearer(l.access)).send(VALID)
    const r1 = await ctx.request.get(PROVIDERS_PATH).set(bearer(l.access))
    expect(r1.body.data).toHaveLength(1)
    expect(r1.body.data[0].provider_id).toBe('my-openai')
  })

  it('create 非法 body → 90002 + 字段明细（zod URL 形态门含在 base_url）', async () => {
    await seedUser(ctx.prisma, mcName('badb'), 'pw-badb-secure')
    const l = await login(ctx.request, mcName('badb'), 'pw-badb-secure')
    const res = await ctx.request
      .post(PROVIDERS_PATH)
      .set(bearer(l.access))
      .send({ ...VALID, provider_id: 'Bad_Format' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('provider_id')
    // URL 形态门（#775，731 §5.1 第一层①）：非 http(s)://host 起头直接拒
    const r2 = await ctx.request
      .post(PROVIDERS_PATH)
      .set(bearer(l.access))
      .send({ ...VALID, provider_id: 'url-x', base_url: 'ftp://open.bigmodel.cn/v4' })
    expect(r2.body.code).toBe(90002)
    expect(r2.body.data.base_url[0]).toContain('http(s)')
    const r3 = await ctx.request
      .post(PROVIDERS_PATH)
      .set(bearer(l.access))
      .send({ ...VALID, provider_id: 'url-y', base_url: 'not a url' })
    expect(r3.body.code).toBe(90002)
    expect(r3.body.data).toHaveProperty('base_url')
    // #812：形态门复用 parseHttpOrigin 后端口域越界（>65535）zod 阶段即拒
    //（旧本地正则 \d{1,5} 放行 :99999 —— 两份 URL 定义的漂移面回归）
    const r4 = await ctx.request
      .post(PROVIDERS_PATH)
      .set(bearer(l.access))
      .send({ ...VALID, provider_id: 'url-z', base_url: 'https://open.bigmodel.cn:99999/v4' })
    expect(r4.body.code).toBe(90002)
    expect(r4.body.data).toHaveProperty('base_url')
  })

  it('api_key_env_id 非法格式 / 未注入 env → 90002 + data.api_key_env_id', async () => {
    await seedUser(ctx.prisma, mcName('env'), 'pw-env-secure')
    const l = await login(ctx.request, mcName('env'), 'pw-env-secure')
    const r1 = await ctx.request
      .post(PROVIDERS_PATH)
      .set(bearer(l.access))
      .send({ ...VALID, api_key_env_id: 'bad-id' })
    expect(r1.body.code).toBe(90002)
    expect(r1.body.data).toHaveProperty('api_key_env_id')
    const r2 = await ctx.request
      .post(PROVIDERS_PATH)
      .set(bearer(l.access))
      .send({ ...VALID, api_key_env_id: 'SOME_OTHER_KEY' })
    expect(r2.body.code).toBe(90002)
    expect(r2.body.data).toHaveProperty('api_key_env_id')
  })

  it('model 条目字段类型非法（name 为对象）→ 90002', async () => {
    await seedUser(ctx.prisma, mcName('mmsh'), 'pw-mmsh-secure')
    const l = await login(ctx.request, mcName('mmsh'), 'pw-mmsh-secure')
    const res = await ctx.request
      .post(PROVIDERS_PATH)
      .set(bearer(l.access))
      .send({ ...VALID, models: [{ id: 'm', name: { bad: 1 } }] })
    expect(res.body.code).toBe(90002)
  })

  it('create 撞同 owner provider_id → 40041（unique 约束）', async () => {
    await seedUser(ctx.prisma, mcName('conf'), 'pw-conf-secure')
    const l = await login(ctx.request, mcName('conf'), 'pw-conf-secure')
    await ctx.request.post(PROVIDERS_PATH).set(bearer(l.access)).send(VALID)
    const res = await ctx.request.post(PROVIDERS_PATH).set(bearer(l.access)).send(VALID)
    expect(res.body.code).toBe(40041)
  })

  it('get 单条 provider / get 未知 → 40040（同码防探测，data null）', async () => {
    await seedUser(ctx.prisma, mcName('get1'), 'pw-get1-secure')
    const l = await login(ctx.request, mcName('get1'), 'pw-get1-secure')
    await ctx.request.post(PROVIDERS_PATH).set(bearer(l.access)).send(VALID)
    const r1 = await ctx.request.get(providerOf('my-openai')).set(bearer(l.access))
    expect(r1.body.code).toBe(0)
    expect(r1.body.data.provider_id).toBe('my-openai')
    const r2 = await ctx.request.get(providerOf('nope')).set(bearer(l.access))
    expect(r2.body).toEqual({ code: 40040, message: expect.any(String), data: null })
  })

  it('put 改 base_url + models / put 未知 → 40040 / put 改 provider_id / 撞既有 → 40041', async () => {
    await seedUser(ctx.prisma, mcName('put1'), 'pw-put1-secure')
    const l = await login(ctx.request, mcName('put1'), 'pw-put1-secure')
    await ctx.request.post(PROVIDERS_PATH).set(bearer(l.access)).send(VALID)
    const r1 = await ctx.request
      .put(providerOf('my-openai'))
      .set(bearer(l.access))
      .send({ ...VALID, models: [{ id: 'glm-5', name: 'GLM 5' }] })
    expect(r1.body.code).toBe(0)
    expect(r1.body.data.models[0].id).toBe('glm-5')
    const r2 = await ctx.request.put(providerOf('nope')).set(bearer(l.access)).send(VALID)
    expect(r2.body.code).toBe(40040)
    // 改 provider_id
    const r3 = await ctx.request
      .put(providerOf('my-openai'))
      .set(bearer(l.access))
      .send({ ...VALID, provider_id: 'renamed' })
    expect(r3.body.code).toBe(0)
    expect(r3.body.data.provider_id).toBe('renamed')
    // 建第二行后，把 'renamed' 改回撞名 → 40041（unique(ownerId, providerId)）
    await ctx.request
      .post(PROVIDERS_PATH)
      .set(bearer(l.access))
      .send({ ...VALID, provider_id: 'second', base_url: 'https://api.minimaxi.com/anthropic' })
    const r4 = await ctx.request
      .put(providerOf('renamed'))
      .set(bearer(l.access))
      .send({ ...VALID, provider_id: 'second' })
    expect(r4.body.code).toBe(40041)
  })

  it('delete 删 provider → 列表清空；delete 未知 → 40040', async () => {
    await seedUser(ctx.prisma, mcName('del1'), 'pw-del1-secure')
    const l = await login(ctx.request, mcName('del1'), 'pw-del1-secure')
    await ctx.request.post(PROVIDERS_PATH).set(bearer(l.access)).send(VALID)
    const r1 = await ctx.request.delete(providerOf('my-openai')).set(bearer(l.access))
    expect(r1.body.code).toBe(0)
    const r2 = await ctx.request.get(PROVIDERS_PATH).set(bearer(l.access))
    expect(r2.body.data).toEqual([])
    const r3 = await ctx.request.delete(providerOf('my-openai')).set(bearer(l.access))
    expect(r3.body.code).toBe(40040)
  })

  it('凭证零落盘：响应体无 apiKey 明文（仅 env marker）', async () => {
    const u = await seedUser(ctx.prisma, mcName('cred'), 'pw-cred-secure')
    const l = await login(ctx.request, mcName('cred'), 'pw-cred-secure')
    await ctx.request.post(PROVIDERS_PATH).set(bearer(l.access)).send(VALID)
    const rows = await ctx.prisma.modelProvider.findMany({ where: { ownerId: u.id } })
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows[0])).not.toMatch(/sk-|secret|password/i)
    expect(rows[0].credentialEnvId).toBe('LLM_API_KEY')
  })

  it('两 provider 顺序按 createdAt（primary 先建、fallbacks 后建语义，列表序即派生序）', async () => {
    await seedUser(ctx.prisma, mcName('ordr'), 'pw-ordr-secure')
    const l = await login(ctx.request, mcName('ordr'), 'pw-ordr-secure')
    await ctx.request.post(PROVIDERS_PATH).set(bearer(l.access)).send(VALID)
    await ctx.request
      .post(PROVIDERS_PATH)
      .set(bearer(l.access))
      .send({ ...VALID, provider_id: 'second', base_url: 'https://api.minimaxi.com/anthropic' })
    const res = await ctx.request.get(PROVIDERS_PATH).set(bearer(l.access))
    expect(res.body.data.map((p: { provider_id: string }) => p.provider_id)).toEqual(['my-openai', 'second'])
  })

  // ---------------------------- #775 新事务：热生效 version bump ----------------------------

  it('create / update / delete 各同事务 bump config_meta.version（+1/次）', async () => {
    await seedUser(ctx.prisma, mcName('vrsn'), 'pw-vrsn-secure')
    const l = await login(ctx.request, mcName('vrsn'), 'pw-vrsn-secure')

    const before = await configVersion()
    await ctx.request.post(PROVIDERS_PATH).set(bearer(l.access)).send(VALID)
    const v1 = await configVersion()
    // 种子行缺失（前序未触写路径的库）→ bump 落 create（version=2：本事务已变更）；
    // 已有种子行（前序 CRUD 已建）→ 常规 increment。两者断言统一为「+1 或 2 起步」。
    expect(v1).toBe(before === null ? 2 : before + 1)

    await ctx.request
      .put(providerOf('my-openai'))
      .set(bearer(l.access))
      .send({ ...VALID, provider_id: 'my-openai', auth_header: false })
    expect(await configVersion()).toBe(v1! + 1)

    await ctx.request.delete(providerOf('my-openai')).set(bearer(l.access))
    expect(await configVersion()).toBe(v1! + 2)

    await ctx.request.post(PROVIDERS_PATH).set(bearer(l.access)).send(VALID)
    expect(await configVersion()).toBe(v1! + 3)
  })

  it('读操作不 bump version（GET/list 零写）', async () => {
    await seedUser(ctx.prisma, mcName('vrd'), 'pw-vrd-secure')
    const l = await login(ctx.request, mcName('vrd'), 'pw-vrd-secure')
    await ctx.request.post(PROVIDERS_PATH).set(bearer(l.access)).send(VALID)
    const before = await configVersion()
    await ctx.request.get(PROVIDERS_PATH).set(bearer(l.access))
    await ctx.request.get(providerOf('my-openai')).set(bearer(l.access))
    expect(await configVersion()).toBe(before)
  })

  // ---------------------------- #775 白名单第一层（731 §5.1）----------------------------

  it('白名单未命中 → 90002 字段级 base_url（不泄露白名单内容）', async () => {
    const u = await seedUser(ctx.prisma, mcName('wlmi'), 'pw-wlmi-secure')
    const l = await login(ctx.request, mcName('wlmi'), 'pw-wlmi-secure')
    const res = await ctx.request
      .post(PROVIDERS_PATH)
      .set(bearer(l.access))
      .send({ ...VALID, base_url: 'https://evil.example.com/v1' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data.base_url[0]).toContain('白名单')
    expect(JSON.stringify(res.body)).not.toContain('bigmodel')
    // DB 无行落下
    expect(await ctx.prisma.modelProvider.count({ where: { ownerId: u.id } })).toBe(0)
  })

  it('子域/端口变体不匹配（精确匹配语义）：prefix 域名与非标端口同拒', async () => {
    await seedUser(ctx.prisma, mcName('wlvr'), 'pw-wlvr-secure')
    const l = await login(ctx.request, mcName('wlvr'), 'pw-wlvr-secure')
    const r1 = await ctx.request
      .post(PROVIDERS_PATH)
      .set(bearer(l.access))
      .send({ ...VALID, provider_id: 'sub1', base_url: 'https://api.open.bigmodel.cn/v1' })
    expect(r1.body.code).toBe(90002)
    const r2 = await ctx.request
      .post(PROVIDERS_PATH)
      .set(bearer(l.access))
      .send({ ...VALID, provider_id: 'sub2', base_url: 'https://open.bigmodel.cn:8443/v1' })
    expect(r2.body.code).toBe(90002)
  })

  it('条目显式端口匹配：8443 条目只放行 8443 origin', async () => {
    await seedUser(ctx.prisma, mcName('wlpt'), 'pw-wlpt-secure')
    await ctx.prisma.providerEndpoint.create({
      data: { scheme: 'https', host: 'port.example.com', port: 8443, note: '', createdBy: 't' },
    })
    const l = await login(ctx.request, mcName('wlpt'), 'pw-wlpt-secure')
    const ok1 = await ctx.request
      .post(PROVIDERS_PATH)
      .set(bearer(l.access))
      .send({ ...VALID, provider_id: 'pt-ok', base_url: 'https://port.example.com:8443/v1' })
    expect(ok1.body.code).toBe(0)
    const bad = await ctx.request
      .post(PROVIDERS_PATH)
      .set(bearer(l.access))
      .send({ ...VALID, provider_id: 'pt-bad', base_url: 'https://port.example.com/v1' })
    expect(bad.body.code).toBe(90002)
  })

  it('put 同样过白名单（改 base_url 到未命中端点 → 90002，DB 原值不变）', async () => {
    const u = await seedUser(ctx.prisma, mcName('wlpu'), 'pw-wlpu-secure')
    const l = await login(ctx.request, mcName('wlpu'), 'pw-wlpu-secure')
    await ctx.request.post(PROVIDERS_PATH).set(bearer(l.access)).send(VALID)
    const res = await ctx.request
      .put(providerOf('my-openai'))
      .set(bearer(l.access))
      .send({ ...VALID, base_url: 'https://evil.example.com/v1' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('base_url')
    const row = await ctx.prisma.modelProvider.findFirst({ where: { ownerId: u.id, providerId: 'my-openai' } })
    expect(row!.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')
  })

  // DNS 私网拒绝面经独立 describe（app 级注入 privateLookup）
})

// 私网解析 + allowPrivate 逃生门（731 §5.1 ③）：独立 app（独立注入），免与主 describe 的
// publicLookup 串台。
describe('models REST 白名单 DNS 私网面（#775）', () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestApp({ models: { lookup: privateLookup as never } })
    await ctx.prisma.providerEndpoint.create({
      data: { scheme: 'https', host: 'api.minimaxi.com', port: null, note: 'test', createdBy: 'test' },
    })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('白名单命中但 DNS 解析私网 → 90002 字段级（防借白名单条目名做内网探测）', async () => {
    await seedUser(ctx.prisma, mcName('pv'), 'pw-pv-secure')
    const l = await login(ctx.request, mcName('pv'), 'pw-pv-secure')
    const res = await ctx.request
      .post(PROVIDERS_PATH)
      .set(bearer(l.access))
      .send({ ...VALID, base_url: 'https://api.minimaxi.com/anthropic' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data.base_url[0]).toContain('10.6.6.6')
  })
})

// allowPrivate 逃生门（dev 自建 vLLM）：同样私网解析，开关开 → 放行。
describe('models REST allowPrivate 逃生门（#775）', () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestApp({ models: { lookup: privateLookup as never, allowPrivate: true } })
    await ctx.prisma.providerEndpoint.create({
      data: { scheme: 'https', host: 'api.minimaxi.com', port: null, note: 'test', createdBy: 'test' },
    })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('allowPrivate=true → 私网解析端点放行（白名单命中即可）', async () => {
    await seedUser(ctx.prisma, mcName('apv'), 'pw-apv-secure')
    const l = await login(ctx.request, mcName('apv'), 'pw-apv-secure')
    const res = await ctx.request
      .post(PROVIDERS_PATH)
      .set(bearer(l.access))
      .send({ ...VALID, provider_id: 'mm', base_url: 'https://api.minimaxi.com/anthropic' })
    expect(res.body.code).toBe(0)
  })
})

// 测试用户名取值域 3–30（helpers USERNAME 约束）；集中生成防撞名。
function mcName(tag: string): string {
  return `m${tag}`.slice(0, 30)
}
