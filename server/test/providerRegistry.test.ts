// ProviderRegistry 集成测试（#775 · 731 §2.4/§4/§5.1 · S1 基座）。
// 覆盖验收「provider CRUD 热生效：配置变更下个 run 生效、进行中 run 不感知」+ 白名单第二层
// 40042 + 缓存 key/失效语义 + 凭证解析。真 SQLite + REST CRUD（触发 version bump）+
// fake ChatModelFactory（S1 接缝，计数构造请求）+ fake DNS。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, login, bearer } from './helpers'
import type { ContainerStatus } from '../src/generated/prisma/client'
import { CODE } from '../src/codes'
import { ProviderRegistry, type ChatModelHandle, type ChatModelRequest } from '../src/runner/providerRegistry'
import type { DnsLookup } from '../src/models/endpointAllowlist'

const DNS_MAP: Record<string, string[]> = {
  'open.bigmodel.cn': ['203.0.113.10'],
  'api.minimaxi.com': ['203.0.113.20'],
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
  models: [{ id: 'glm-4-plus', name: 'GLM-4 Plus' }],
}

// fake 工厂：记录构造请求，返回可区分实例（第 N 次构造 → marker-N）。
class FakeFactory {
  calls: ChatModelRequest[] = []
  async createModel(req: ChatModelRequest): Promise<ChatModelHandle> {
    this.calls.push(req)
    return { marker: `instance-${this.calls.length}` }
  }
}

describe('ProviderRegistry（热生效 + 白名单第二层 + 缓存语义）', () => {
  let ctx: TestContext
  const providersOf = (name: string): string => `/api/v1/containers/${name}/models/providers`
  const providerOf = (name: string, pid: string): string => `${providersOf(name)}/${pid}`
  let containerName: string

  beforeAll(async () => {
    ctx = await setupTestApp({ models: { resolveDns } })
    await ctx.prisma.configMeta.create({ data: { id: 1, version: 1 } })
    await ctx.prisma.providerEndpoint.create({ data: { scheme: 'https', host: 'open.bigmodel.cn', port: null, createdBy: '' } })
    await ctx.prisma.providerEndpoint.create({ data: { scheme: 'https', host: 'api.minimaxi.com', port: null, createdBy: '' } })
    const u = await seedUser(ctx.prisma, 'regown', 'pw-regown-secure')
    const row = await ctx.prisma.container.create({
      data: {
        name: 'regown1',
        port: 19321,
        ownerId: u.id,
        token: 't',
        homeDir: '/h',
        image: 'img',
        status: 'running' as ContainerStatus,
      },
    })
    containerName = row.name
    const l = await login(ctx.request, 'regown', 'pw-regown-secure')
    const res = await ctx.request.post(providersOf(containerName)).set(bearer(l.access)).send(VALID)
    expect(res.body.code).toBe(0)
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  function makeRegistry(factory: FakeFactory, env: Record<string, string> = { LLM_API_KEY: 'test-key' }): ProviderRegistry {
    return new ProviderRegistry({
      prisma: ctx.prisma,
      factory,
      lookupEnv: (name) => env[name],
    })
  }

  it('ensureFresh + getModel：首 run 构造（缓存 miss）→ 同 key 二次命中缓存（工厂恰一次）', async () => {
    const factory = new FakeFactory()
    const registry = makeRegistry(factory)
    const owner = (await ctx.prisma.container.findUnique({ where: { name: containerName } }))!.ownerId
    const snap = await registry.ensureFresh(owner)
    const model = await registry.getModel(snap, 'my-openai', 'glm-4-plus')
    expect(model).toEqual({ marker: 'instance-1' })
    // 构造请求形状（#777 initChatModel 装配面契约）
    expect(factory.calls[0]).toMatchObject({
      lcProvider: 'openai',
      modelId: 'glm-4-plus',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'test-key',
      authHeader: true,
    })
    expect(typeof factory.calls[0].fetch).toBe('function')
    // 同 (owner, provider, model, version) 二次取 → 缓存命中，无第二次构造
    const again = await registry.getModel(snap, 'my-openai', 'glm-4-plus')
    expect(again).toEqual({ marker: 'instance-1' })
    expect(factory.calls).toHaveLength(1)
  })

  it('缓存 key 含 modelId：同 provider 不同模型各自构造', async () => {
    const factory = new FakeFactory()
    const registry = makeRegistry(factory)
    const inst = (await ctx.prisma.container.findUnique({ where: { name: containerName } }))!
    // 扩 modelsJson 值域（直改库 + bump 版本，模拟第二模型可用）
    await ctx.prisma.modelProvider.update({
      where: { ownerId_providerId: { ownerId: inst.ownerId, providerId: 'my-openai' } },
      data: { modelsJson: JSON.stringify([{ id: 'glm-4-plus' }, { id: 'glm-4-air' }]) },
    })
    await ctx.prisma.configMeta.update({ where: { id: 1 }, data: { version: { increment: 1 } } })
    const snap = await registry.ensureFresh(inst.ownerId)
    await registry.getModel(snap, 'my-openai', 'glm-4-plus')
    await registry.getModel(snap, 'my-openai', 'glm-4-air')
    expect(factory.calls).toHaveLength(2)
    expect(factory.calls[1].modelId).toBe('glm-4-air')
  })

  it('热生效：CRUD 变更后下个 run 生效（新 baseUrl 构造），进行中 run（旧快照）不感知', async () => {
    const factory = new FakeFactory()
    const registry = makeRegistry(factory)
    const owner = (await ctx.prisma.container.findUnique({ where: { name: containerName } }))!.ownerId

    // run 1：启动取快照（旧配置），构造 instance-1（旧 baseUrl）
    const snapRun1 = await registry.ensureFresh(owner)
    await registry.getModel(snapRun1, 'my-openai', 'glm-4-plus')
    expect(factory.calls).toHaveLength(1)
    expect(factory.calls[0].baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')

    // 配置变更（REST PUT：白名单第一层放行 + 同事务 version bump；models 收敛为 MiniMax-M3）
    const l = await login(ctx.request, 'regown', 'pw-regown-secure')
    const update = { ...VALID, base_url: 'https://api.minimaxi.com/anthropic', models: [{ id: 'MiniMax-M3' }] }
    const res = await ctx.request.put(providerOf(containerName, 'my-openai')).set(bearer(l.access)).send(update)
    expect(res.body.code).toBe(0)

    // run 1（进行中）变更后立刻再取模型：本 registry 尚未重载（无推送）→ 快照版本键缓存命中
    // ——进行中 run 零感知（不重建、不换配置）
    const midRun = await registry.getModel(snapRun1, 'my-openai', 'glm-4-plus')
    expect(midRun).toEqual({ marker: 'instance-1' })
    expect(factory.calls).toHaveLength(1)

    // run 2：启动 ensureFresh 读到新版本 → 丢缓存重载
    const snapRun2 = await registry.ensureFresh(owner)
    expect(snapRun2.version).toBeGreaterThan(snapRun1.version)

    // run 1 进行中再取模型（缓存已随版本丢失）→ 按旧快照配置重建——仍旧 baseUrl，绝不中途换配置
    const midRun2 = await registry.getModel(snapRun1, 'my-openai', 'glm-4-plus')
    expect(midRun2).toEqual({ marker: 'instance-2' })
    expect(factory.calls[1].baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')

    // run 2 取模型：新配置构造（变更下个 run 生效）
    const fresh = await registry.getModel(snapRun2, 'my-openai', 'MiniMax-M3')
    expect(fresh).toEqual({ marker: 'instance-3' })
    expect(factory.calls[2].baseUrl).toBe('https://api.minimaxi.com/anthropic')
  })

  it('白名单第二层：admin 直改库绕过 API 层（baseUrl 不在白名单）→ 构造前复验 40042', async () => {
    const factory = new FakeFactory()
    const registry = makeRegistry(factory)
    const inst = (await ctx.prisma.container.findUnique({ where: { name: containerName } }))!
    // 直改库（模拟 admin 绕过 REST 第一层）+ bump 版本触发重载
    await ctx.prisma.modelProvider.update({
      where: { ownerId_providerId: { ownerId: inst.ownerId, providerId: 'my-openai' } },
      data: { baseUrl: 'https://evil.io/steal-key' },
    })
    await ctx.prisma.configMeta.update({ where: { id: 1 }, data: { version: { increment: 1 } } })
    const snap = await registry.ensureFresh(inst.ownerId)
    await expect(registry.getModel(snap, 'my-openai', 'MiniMax-M3')).rejects.toMatchObject({
      code: CODE.PROVIDER_ENDPOINT_NOT_ALLOWED,
    })
    expect(factory.calls.filter((c) => c.baseUrl === 'https://evil.io/steal-key')).toHaveLength(0) // 未构造
  })

  it('白名单第二层：快照内已列端点仍逐请求复验（fetch wrapper 闭包持快照白名单）', async () => {
    const factory = new FakeFactory()
    const registry = makeRegistry(factory)
    const owner = (await ctx.prisma.container.findUnique({ where: { name: containerName } }))!.ownerId
    // 上一用例把行改成 evil.io——先改回白名单端点，验证 wrapper 对 wrapper 层未命中 origin 抛 40042 形错误
    await ctx.prisma.modelProvider.update({
      where: { ownerId_providerId: { ownerId: owner, providerId: 'my-openai' } },
      data: { baseUrl: 'https://api.minimaxi.com/anthropic' },
    })
    await ctx.prisma.configMeta.update({ where: { id: 1 }, data: { version: { increment: 1 } } })
    const snap = await registry.ensureFresh(owner)
    await registry.getModel(snap, 'my-openai', 'MiniMax-M3')
    const wrapper = factory.calls[factory.calls.length - 1].fetch
    await expect(
      wrapper('https://evil.io/steal-key', { method: 'POST' }),
    ).rejects.toMatchObject({ code: CODE.PROVIDER_ENDPOINT_NOT_ALLOWED })
    // 合法 origin 的响应面由 whitelistedFetch.test.ts 覆盖（此处不触网，仅证未命中拒绝）
  })

  it('凭证缺失（env 无 LLM_API_KEY）→ 90003', async () => {
    const factory = new FakeFactory()
    const registry = makeRegistry(factory, {})
    const owner = (await ctx.prisma.container.findUnique({ where: { name: containerName } }))!.ownerId
    const snap = await registry.ensureFresh(owner)
    await expect(registry.getModel(snap, 'my-openai', 'MiniMax-M3')).rejects.toMatchObject({
      code: CODE.LLM_NOT_CONFIGURED,
    })
    expect(factory.calls).toHaveLength(0)
  })

  it('快照外 provider → 40040；modelsJson 集合外 modelId → 90002（值域拒绝，731 §5.2）', async () => {
    const factory = new FakeFactory()
    const registry = makeRegistry(factory)
    const owner = (await ctx.prisma.container.findUnique({ where: { name: containerName } }))!.ownerId
    const snap = await registry.ensureFresh(owner)
    await expect(registry.getModel(snap, 'no-such', 'm')).rejects.toMatchObject({ code: CODE.PROVIDER_NOT_FOUND })
    await expect(registry.getModel(snap, 'my-openai', 'bogus-model')).rejects.toMatchObject({
      code: CODE.VALIDATION_FAILED,
    })
    expect(factory.calls.filter((c) => c.modelId === 'bogus-model')).toHaveLength(0)
  })

  it('未触及配置变更：版本不变 + 快照已有 → ensureFresh 不重载（工厂计数不变）', async () => {
    const factory = new FakeFactory()
    const registry = makeRegistry(factory)
    const owner = (await ctx.prisma.container.findUnique({ where: { name: containerName } }))!.ownerId
    const snap = await registry.ensureFresh(owner)
    await registry.getModel(snap, 'my-openai', 'MiniMax-M3')
    const n = factory.calls.length
    await registry.ensureFresh(owner) // 版本判等 → 直接用缓存
    await registry.getModel(snap, 'my-openai', 'MiniMax-M3')
    expect(factory.calls).toHaveLength(n) // 无重建
  })
})
