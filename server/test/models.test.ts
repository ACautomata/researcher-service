// models REST 契约测试（#336 · 接缝 #2 信封 + 归属前置 + 写盘回滚）。
// 端点 /api/v1/containers/<name>/models/providers[/<pid>]；snake_case wire（平移 Django + 前端）。
// 注入真 TemplateModelConfigWriter（tmp fleet root + 模板），断言重渲染后的盘上 openclaw.json；
// 注入可切换失败模式的 writer 测 90003 写盘回滚（不碰真 docker）。
//
// 验收映射：#336 —— 信封 + 归属前置生效 / provider_id 撞 40041 / 越权与不存在同码 40040 /
// 改后 openclaw.json 重渲染 + 热加载语义（DB 单一真值源）/ 写盘失败回滚 DB 行 90003 /
// api_key_env_id 非法格式 90002 / 归属对偶 + 凭证零落盘。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import type { ContainerStatus } from '../src/generated/prisma/client'
import { TemplateModelConfigWriter, type ModelConfigWriter } from '../src/models/configWriter'
import { ConfigWriteError } from '../src/containers/configStore'
import { ConfigurationError } from '../src/containers/errors'

let seq = 0

// 临时 fleet root + 最小模板（gateway.auth 供 ConfigRenderer 强制安全不变量）。
function makeModelsFleet(): { fleetRoot: string; writer: ModelConfigWriter } {
  seq += 1
  const fleetRoot = mkdtempSync(path.join(tmpdir(), `models-rest-${process.pid}-${seq}-`))
  const templateJson = path.join(fleetRoot, 'openclaw.template.json')
  writeFileSync(
    templateJson,
    JSON.stringify({ gateway: { auth: {} }, models: { providers: {} } }, null, 2),
  )
  // root 与 templateDir 同值即可（ConfigStore 只用 root 拼 home 路径，不读 templateDir）
  const cfg = { root: fleetRoot, templateJson, llmApiKey: 'test-llm-key' }
  return { fleetRoot, writer: new TemplateModelConfigWriter(cfg) }
}

// 可切换失败模式的 writer：'write' → ConfigWriteError（写盘失败）；'config' → ConfigurationError
// （LLM key 缺失）；'slow' → 挂起 5.2s（超 Prisma 默认 5s 事务窗口，测 #366 显式 timeout）；
// 其余透传真 writer。用 try/finally 复位，防污染后续用例。
type FailMode = 'none' | 'write' | 'config' | 'slow'
let realWriter: ModelConfigWriter = { rewrite: async () => {} }
let failMode: FailMode = 'none'
const writer: ModelConfigWriter = {
  async rewrite(opts) {
    if (failMode === 'write') throw new ConfigWriteError(opts.name, '/x/openclaw.json')
    if (failMode === 'config') throw new ConfigurationError('LLM_API_KEY')
    if (failMode === 'slow') {
      await new Promise((r) => setTimeout(r, 5_200)) // 慢写盘：超过 Prisma 默认 5s 窗口
    }
    return realWriter.rewrite(opts)
  },
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

describe('models REST（接缝 #2 + #336）', () => {
  let ctx: TestContext
  let fleetRoot: string
  const providersOf = (name: string): string => `/api/v1/containers/${name}/models/providers`
  const providerOf = (name: string, pid: string): string => `${providersOf(name)}/${pid}`

  beforeAll(async () => {
    const tmp = makeModelsFleet()
    fleetRoot = tmp.fleetRoot
    realWriter = tmp.writer
    ctx = await setupTestApp({ models: { configWriter: writer } })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  // 每容器独立 name/port（name/port 全局唯一，跨测试不得复用）。返回行 id（代系，读盘路径用）。
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

  function readConfig(id: string): Record<string, any> {
    // #366：config 落 home 目录内（instances/<id>/home/openclaw.json，目录 bind 下 rename 容器内可见）
    const text = readFileSync(path.join(fleetRoot, 'instances', id, 'home', 'openclaw.json'), 'utf8')
    return JSON.parse(text)
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

  it('creating 容器 POST → 20043（防 lost update）；GET 只读放行', async () => {
    const u = await seedUser(ctx.prisma, 'mcreat', 'pw-mcreat-secure')
    const { name } = await seedContainer(u.id, 'creating')
    const l = await login(ctx.request, 'mcreat', 'pw-mcreat-secure')
    const res = await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    expect(res.body.code).toBe(20043)
    // GET 只读无写盘副作用，不拒 creating
    const rget = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(rget.body.code).toBe(0)
  })

  it('#366 removing 容器 POST/PUT/DELETE → 20043（防与删除 rmtree 竞态）；GET 只读放行', async () => {
    // codex P2：删除后台 rmtree 期间放行写 → ConfigStore 重建目录 + 写盘与 rmtree 竞态 →
    // orphan 目录残留。removing 与 creating 同属「生命周期忙」拒写；GET 只读仍放行。
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
    // GET 只读无写盘副作用，不拒 removing
    const rget = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(rget.body.code).toBe(0)
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

  it('create 返回 provider（snake_case wire）+ 重渲染 openclaw.json（SecretRef 不落明文）', async () => {
    const u = await seedUser(ctx.prisma, 'mcreate', 'pw-mcreate-secure')
    const { name, id } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mcreate', 'pw-mcreate-secure')
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
    // 验收：保存即重渲染生效（DB 单一真值源 → openclaw.json）
    const cfg = readConfig(id)
    const prov = cfg.models.providers['my-openai']
    expect(prov.api).toBe('openai-completions')
    expect(prov.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(prov.apiKey).toEqual({ source: 'env', provider: 'default', id: 'LLM_API_KEY' })
    expect(cfg.agents.defaults.model.primary).toBe('my-openai/glm-4-plus')
  })

  it('list 显示已建 provider', async () => {
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
    const u = await seedUser(ctx.prisma, 'minval', 'pw-minval-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'minval', 'pw-minval-secure')
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
    const r4 = await ctx.request
      .post(providersOf(name))
      .set(bearer(l.access))
      .send({ ...VALID, models: [{ name: 'NoId' }] })
    expect(r4.body.code).toBe(90002)
    expect(r4.body.data).toHaveProperty('models')
  })

  it('api_key_env_id 非法格式 / 未注入 env → 90002 + data.api_key_env_id', async () => {
    const u = await seedUser(ctx.prisma, 'menv', 'pw-menv-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'menv', 'pw-menv-secure')
    // 非法格式（小写开头）
    const r1 = await ctx.request
      .post(providersOf(name))
      .set(bearer(l.access))
      .send({ ...VALID, api_key_env_id: 'lower_key' })
    expect(r1.body.code).toBe(90002)
    expect(r1.body.data.api_key_env_id).toBeDefined()
    // 合法格式但容器未注入（当前仅 LLM_API_KEY）——regex 管格式、成员校验管「容器真持有」
    const r2 = await ctx.request
      .post(providersOf(name))
      .set(bearer(l.access))
      .send({ ...VALID, api_key_env_id: 'ZHIPU_API_KEY' })
    expect(r2.body.code).toBe(90002)
    expect(r2.body.data.api_key_env_id).toBeDefined()
  })

  it('create 撞同容器 provider_id → 40041（unique 约束）', async () => {
    const u = await seedUser(ctx.prisma, 'mdup', 'pw-mdup-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mdup', 'pw-mdup-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    const res = await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    expect(res.body.code).toBe(40041)
  })

  it('create 撞不存在容器 → 20040（容器门先于 body 校验）', async () => {
    await seedUser(ctx.prisma, 'mmiss', 'pw-mmiss-secure')
    const l = await login(ctx.request, 'mmiss', 'pw-mmiss-secure')
    const res = await ctx.request.post(providersOf('nope')).set(bearer(l.access)).send(VALID)
    expect(res.body.code).toBe(20040)
  })

  // ---------------------------- 回读 / 改 / 删 ----------------------------

  it('get 单条 provider', async () => {
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
    const u = await seedUser(ctx.prisma, 'mputnf', 'pw-mputnf-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mputnf', 'pw-mputnf-secure')
    const res = await ctx.request.put(providerOf(name, 'nope')).set(bearer(l.access)).send(VALID)
    expect(res.body).toEqual({ code: 40040, message: expect.any(String), data: null })
  })

  it('put 改 base_url + models → 重渲染生效', async () => {
    const u = await seedUser(ctx.prisma, 'mput', 'pw-mput-secure')
    const { name, id } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mput', 'pw-mput-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    const update = {
      ...VALID,
      base_url: 'https://api.deepseek.com/v1',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    }
    const res = await ctx.request.put(providerOf(name, 'my-openai')).set(bearer(l.access)).send(update)
    expect(res.body.code).toBe(0)
    expect(res.body.data.base_url).toBe('https://api.deepseek.com/v1')
    const cfg = readConfig(id)
    const prov = cfg.models.providers['my-openai']
    expect(prov.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(prov.apiKey.id).toBe('LLM_API_KEY')
    expect(cfg.agents.defaults.model.primary).toBe('my-openai/deepseek-chat')
  })

  it('put 改 provider_id → 重渲染引用随之更新', async () => {
    const u = await seedUser(ctx.prisma, 'mputid', 'pw-mputid-secure')
    const { name, id } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mputid', 'pw-mputid-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    const update = { ...VALID, provider_id: 'renamed', models: [{ id: 'g', name: 'G' }] }
    const res = await ctx.request.put(providerOf(name, 'my-openai')).set(bearer(l.access)).send(update)
    expect(res.body.code).toBe(0)
    const cfg = readConfig(id)
    expect(cfg.models.providers['my-openai']).toBeUndefined()
    expect(cfg.models.providers['renamed']).toBeDefined()
    expect(cfg.agents.defaults.model.primary).toBe('renamed/g')
  })

  it('put 撞同容器既有 provider_id → 40041（非裸 500）', async () => {
    const u = await seedUser(ctx.prisma, 'mputcol', 'pw-mputcol-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mputcol', 'pw-mputcol-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID) // my-openai
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send({ ...VALID, provider_id: 'backup' })
    const collide = { ...VALID, provider_id: 'backup' } // 想把 my-openai 改成 backup
    const res = await ctx.request.put(providerOf(name, 'my-openai')).set(bearer(l.access)).send(collide)
    expect(res.body.code).toBe(40041)
  })

  it('delete 删 provider → 列表清空 + 重渲染无悬空引用', async () => {
    const u = await seedUser(ctx.prisma, 'mdel', 'pw-mdel-secure')
    const { name, id } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mdel', 'pw-mdel-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    const res = await ctx.request.delete(providerOf(name, 'my-openai')).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data).toBeNull()
    const list = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(list.body.data).toEqual([])
    const cfg = readConfig(id)
    expect(cfg.models.providers['my-openai']).toBeUndefined()
    // 空 providers → base 透传（agents 键可能整个消失），全 cfg 无悬空引用
    expect(JSON.stringify(cfg)).not.toContain('my-openai/')
  })

  it('delete 未知 provider → 40040', async () => {
    const u = await seedUser(ctx.prisma, 'mdelnf', 'pw-mdelnf-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mdelnf', 'pw-mdelnf-secure')
    const res = await ctx.request.delete(providerOf(name, 'nope')).set(bearer(l.access))
    expect(res.body.code).toBe(40040)
  })

  it('两 provider：primary 先建、fallbacks 后建（入参序）', async () => {
    const u = await seedUser(ctx.prisma, 'mtwo', 'pw-mtwo-secure')
    const { name, id } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mtwo', 'pw-mtwo-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    await ctx.request
      .post(providersOf(name))
      .set(bearer(l.access))
      .send({ ...VALID, provider_id: 'backup', api: 'anthropic-messages', models: [{ id: 'm', name: 'M' }] })
    const cfg = readConfig(id)
    expect(cfg.agents.defaults.model.primary).toBe('my-openai/glm-4-plus')
    expect(cfg.agents.defaults.model.fallbacks).toEqual(['backup/m'])
  })

  // ---------------------------- 凭证零落盘 ----------------------------

  it('凭证零落盘：响应体与盘上均无 apiKey 明文（仅 env marker）', async () => {
    const u = await seedUser(ctx.prisma, 'mzero', 'pw-mzero-secure')
    const { name, id } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mzero', 'pw-mzero-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    // 响应体（list + get）无明文 key 字段
    const listRes = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(listRes.body.data[0]).not.toHaveProperty('api_key')
    expect(listRes.body.data[0].api_key_env_id).toBe('LLM_API_KEY')
    const getRes = await ctx.request.get(providerOf(name, 'my-openai')).set(bearer(l.access))
    expect(getRes.body.data).not.toHaveProperty('api_key')
    expect(getRes.body.data.api_key_env_id).toBe('LLM_API_KEY')
    // 盘上 openclaw.json：apiKey 恒为 SecretRef，无明文（断言不含真实 key 值 'test-llm-key'
    // 与通用明文形态——若某处把 key 原样写盘，这里必然抓住）
    const cfg = readConfig(id)
    expect(cfg.models.providers['my-openai'].apiKey).toEqual({
      source: 'env',
      provider: 'default',
      id: 'LLM_API_KEY',
    })
    const serialized = JSON.stringify(cfg)
    expect(serialized).not.toContain('test-llm-key')
    expect(serialized).not.toContain('"apiKey": "')
  })

  // ---------------------------- 写盘失败回滚（90003，DB 与盘上配置绝不发散）----------------------------

  it('#366 事务超时修复：rewrite 慢写盘（>默认 5s）不触发 P2028 超时回滚', async () => {
    // codex P1：Prisma 交互式事务默认 5s 超时——rewrite 含 fs 写盘，慢卷时可能超 5s →
    // DB 回滚但盘上已落盘（发散）。修复后 $transaction 显式 timeout 30s；本用例让 writer
    // 挂起 5.2s（超默认窗口），若未修 create 会抛 P2028 事务超时 → 500；修后正常 200。
    const u = await seedUser(ctx.prisma, 'mslowtx', 'pw-mslowtx-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mslowtx', 'pw-mslowtx-secure')
    failMode = 'slow'
    try {
      const res = await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
      expect(res.body.code).toBe(0) // 未触发事务超时（显式 30s 生效）
      expect(res.body.data.provider_id).toBe('my-openai')
    } finally {
      failMode = 'none'
    }
    const list = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(list.body.data).toHaveLength(1) // DB 行在（事务提交成功）
  }, 15_000)

  it('create 写盘失败 → 90003 + DB 回滚（无 orphan provider 行）', async () => {
    const u = await seedUser(ctx.prisma, 'mfailc', 'pw-mfailc-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mfailc', 'pw-mfailc-secure')
    failMode = 'write'
    try {
      const res = await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
      expect(res.body.code).toBe(90003)
    } finally {
      failMode = 'none'
    }
    const list = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(list.body.data).toEqual([]) // 无 orphan：DB 已回滚
  })

  it('put 写盘失败 → 90003 + DB 回滚（原值仍在）', async () => {
    const u = await seedUser(ctx.prisma, 'mfailp', 'pw-mfailp-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mfailp', 'pw-mfailp-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    const update = { ...VALID, base_url: 'https://api.deepseek.com/v1' }
    failMode = 'write'
    try {
      const res = await ctx.request.put(providerOf(name, 'my-openai')).set(bearer(l.access)).send(update)
      expect(res.body.code).toBe(90003)
    } finally {
      failMode = 'none'
    }
    // DB 回滚：base_url 仍是原值
    const getRes = await ctx.request.get(providerOf(name, 'my-openai')).set(bearer(l.access))
    expect(getRes.body.data.base_url).toBe('https://open.bigmodel.cn/api/paas/v4')
  })

  it('delete 写盘失败 → 90003 + DB 回滚（provider 仍在）', async () => {
    const u = await seedUser(ctx.prisma, 'mfaild', 'pw-mfaild-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mfaild', 'pw-mfaild-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    failMode = 'write'
    try {
      const res = await ctx.request.delete(providerOf(name, 'my-openai')).set(bearer(l.access))
      expect(res.body.code).toBe(90003)
    } finally {
      failMode = 'none'
    }
    const list = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(list.body.data).toHaveLength(1) // DB 回滚：provider 仍在
  })

  it('LLM key 未配置（ConfigurationError）→ 90003 + DB 回滚', async () => {
    const u = await seedUser(ctx.prisma, 'mllm', 'pw-mllm-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mllm', 'pw-mllm-secure')
    failMode = 'config'
    try {
      const res = await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
      expect(res.body.code).toBe(90003)
    } finally {
      failMode = 'none'
    }
    const list = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(list.body.data).toEqual([])
  })

  it('写盘失败（真实 ConfigStore 原子路径 EACCES）→ 90003 + 既有配置不被污染 + tmp 已清理', async () => {
    // 对齐 Django test_rewrite_failure_leaves_existing_config_intact：先成功落一份合法配置，
    // 再让写盘在 tmp+rename 阶段失败（目录 chmod 只读 → rename EACCES），断言盘上保留上一份
    // 一致配置、无残留 tmp（ConfigStore 原子性在 models 写路径上的端到端验证）。
    const u = await seedUser(ctx.prisma, 'mfailfs', 'pw-mfailfs-secure')
    const { name, id } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mfailfs', 'pw-mfailfs-secure')
    await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
    const cfgPath = path.join(fleetRoot, 'instances', id, 'home', 'openclaw.json')
    const good = readFileSync(cfgPath, 'utf8')
    expect(good).toContain('my-openai')

    chmodSync(path.dirname(cfgPath), 0o555) // 目录只读：tmp 可写（文件模式 0644 已定）但 rename 进不来
    try {
      const update = { ...VALID, base_url: 'https://api.deepseek.com/v1' }
      const res = await ctx.request.put(providerOf(name, 'my-openai')).set(bearer(l.access)).send(update)
      expect(res.body.code).toBe(90003)
    } finally {
      chmodSync(path.dirname(cfgPath), 0o755) // 复原，保证 afterAll 清理
    }
    // 盘上保留上一份一致配置（未被截断/污染）；无残留 tmp
    expect(readFileSync(cfgPath, 'utf8')).toBe(good)
    const leftover = readdirSync(path.dirname(cfgPath)).filter((f) => f.includes('.tmp'))
    expect(leftover).toEqual([])
    // DB 回滚：base_url 仍是原值
    const getRes = await ctx.request.get(providerOf(name, 'my-openai')).set(bearer(l.access))
    expect(getRes.body.data.base_url).toBe('https://open.bigmodel.cn/api/paas/v4')
  })

  // ---------------------------- 模板加载错误转译（#366 codex P2）----------------------------
  // 模板损坏/缺失时 rewrite 惰性加载应抛 ConfigurationError（90003）——否则裸 SyntaxError 被
  // 全局错误面当 body 解析失败误译 90002、文件缺失落 90000（错误分类错误，客户端收不到
  // 文档化的配置失败信封）。

  it('#366 模板损坏（JSON.parse SyntaxError）→ 90003 而非 90002/90000', async () => {
    const u = await seedUser(ctx.prisma, 'mtbad', 'pw-mtbad-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mtbad', 'pw-mtbad-secure')
    // 独立 writer 实例 + 损坏模板（首次 rewrite 才惰性加载——复用 writer 会被已缓存
    // renderer 污染，测不到加载路径）
    const badTemplate = path.join(fleetRoot, 'openclaw.template.bad.json')
    writeFileSync(badTemplate, '{ this is not json')
    const badWriter: ModelConfigWriter = new TemplateModelConfigWriter({
      root: fleetRoot,
      templateJson: badTemplate,
      llmApiKey: 'test-llm-key',
    })
    const saved = realWriter
    realWriter = badWriter
    try {
      const res = await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
      expect(res.body.code).toBe(90003) // 配置失败信封，非 90002（body 是合法的）
    } finally {
      realWriter = saved
    }
    // DB 回滚：无 orphan provider 行
    const list = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(list.body.data).toEqual([])
  })

  it('#366 模板缺失（readFile ENOENT）→ 90003 而非 90000', async () => {
    const u = await seedUser(ctx.prisma, 'mtmiss', 'pw-mtmiss-secure')
    const { name } = await seedContainer(u.id)
    const l = await login(ctx.request, 'mtmiss', 'pw-mtmiss-secure')
    const templatePath = path.join(fleetRoot, 'openclaw.template.json')
    const good = readFileSync(templatePath, 'utf8')
    // 换一个指向不存在模板的 writer（懒加载在首次 rewrite 时才触发）
    const missingWriter: ModelConfigWriter = new TemplateModelConfigWriter({
      root: fleetRoot,
      templateJson: path.join(fleetRoot, 'no-such-template.json'),
      llmApiKey: 'test-llm-key',
    })
    const saved = realWriter
    realWriter = missingWriter
    try {
      const res = await ctx.request.post(providersOf(name)).set(bearer(l.access)).send(VALID)
      expect(res.body.code).toBe(90003) // 配置失败信封，非 90000 未知错误
    } finally {
      realWriter = saved
      writeFileSync(templatePath, good)
    }
    const list = await ctx.request.get(providersOf(name)).set(bearer(l.access))
    expect(list.body.data).toEqual([])
  })
})
