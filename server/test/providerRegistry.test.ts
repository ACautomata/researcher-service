// ProviderRegistry 测试（#775 验收 ①「热生效」+ 白名单第二层 40042 + 缓存/默认链）。
//
// 接缝：ModelFactory 注入 fake（断言参数面，零网络）；prisma 走 setupTestApp 临时库。
// 热生效语义（731 §4 方案二）：run 启动读 config_meta.version 判等——不等才重载；
// 进行中 run 持旧快照对象不感知（快照不可变性 + 旧 version 缓存 key 继续命中）。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, login, bearer } from './helpers'
import { ProviderRegistry, resolveModelRef, type ChatModelFactory } from '../src/runner/providerRegistry'
import { EndpointNotAllowedError, createWhitelistFetch, effectivePort, originKey } from '../src/runner/allowlist'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

// REST 面 DNS 校验 fake（S1 串成用例走 ModelProviderService 真链；免真 DNS）
const publicLookup = async () => [{ address: '203.0.113.10', family: 4 }]

// fake 模型：记录身份 + withConfig/withFallbacks spy（默认链断言面）。
function makeFakeFactory() {
  const calls: Array<{ model: string; lcProvider: string; baseUrl: string; apiKey: string; authHeader: boolean }> = []
  const factory: ChatModelFactory = async (model, opts) => {
    calls.push({ model, lcProvider: opts.lcProvider, baseUrl: opts.baseUrl, apiKey: opts.apiKey, authHeader: opts.authHeader })
    const stub = {
      stubModel: model,
      invoke: async () => ({ content: `fake:${model}` }),
      withConfig(cfg?: { configurable?: { model?: string } }) {
        return { ...this, stubModel: cfg?.configurable?.model ?? model }
      },
      withFallbacks: vi.fn(function (this: unknown, o: { fallbacks: unknown[] }) {
        return { stubChain: (this as { stubModel: string }).stubModel, primary: this, fallbacks: o.fallbacks }
      }),
    }
    return stub as unknown as BaseChatModel
  }
  return { factory, calls }
}

async function seedEndpoint(ctx: TestContext, host: string, port: number | null = null): Promise<void> {
  await ctx.prisma.providerEndpoint.create({
    data: { scheme: 'https', host, port, note: '', createdBy: 't' },
  })
}

async function seedProvider(
  ctx: TestContext,
  ownerId: string,
  providerId: string,
  baseUrl: string,
  lcProvider: 'openai' | 'anthropic' = 'openai',
  modelIds: string[] = ['m-1'],
): Promise<void> {
  await ctx.prisma.modelProvider.create({
    data: {
      ownerId,
      providerId,
      lcProvider,
      baseUrl,
      credentialEnvId: 'LLM_API_KEY',
      authHeader: true,
      modelsJson: JSON.stringify(modelIds.map((id) => ({ id, name: id }))),
    },
  })
}

const bump = async (ctx: TestContext): Promise<void> => {
  await ctx.prisma.configMeta.update({ where: { id: 1 }, data: { version: { increment: 1 } } })
}

describe('ProviderRegistry（#775 · 731 §2.4/§4）', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await setupTestApp({ models: { lookup: publicLookup as never } })
    await ctx.prisma.configMeta.upsert({
      where: { id: 1 },
      create: { id: 1, version: 1 },
      update: {},
    })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  // ---------------- 热生效（验收 ①）----------------

  it('快照按 config_meta.version 判等：不等才重载（CRUD bump → 下个 run 见新配置）', async () => {
    const u = await seedUser(ctx.prisma, 'rguser1', 'pw-rguser1-secure')
    await seedEndpoint(ctx, 'api.example.com')
    await seedProvider(ctx, u.id, 'p1', 'https://api.example.com/v1')

    const { factory } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-test', modelFactory: factory })

    const snap1 = await reg.getSnapshot(u.id)
    expect(snap1.version).toBe(1)
    expect(snap1.providers.map((p) => p.providerId)).toEqual(['p1'])

    // CRUD 等价：直接建行 + bump（ModelProviderService 走同一路径）
    await seedProvider(ctx, u.id, 'p2', 'https://api.example.com/v2')
    await bump(ctx)

    const snap2 = await reg.getSnapshot(u.id)
    expect(snap2.version).toBe(2)
    expect(snap2.providers.map((p) => p.providerId)).toEqual(['p1', 'p2'])
  })

  it('进行中 run 不感知：同 version 缓存命中同实例；bump 后旧快照驱动重构造仍用旧配置（配置视图冻结）', async () => {
    const u = await seedUser(ctx.prisma, 'rguser2', 'pw-rguser2-secure')
    await seedEndpoint(ctx, 'api2.example.com')
    await seedProvider(ctx, u.id, 'pa', 'https://api2.example.com/v1', 'openai', ['a-1'])

    const { factory, calls } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-test', modelFactory: factory })

    const snap1 = await reg.getSnapshot(u.id)
    const m1 = await reg.getModel(snap1, 'pa') // version=当前，构造一次
    expect(calls).toHaveLength(1)

    // 同 version 再取 → 命中缓存（同实例，零重构造）
    const m1Same = await reg.getModel(snap1, 'pa')
    expect(m1Same).toBe(m1)
    expect(calls).toHaveLength(1)

    // 配置变更（版本 bump）+ 删库中旧行模拟（provider 配置真变了）
    await seedProvider(ctx, u.id, 'pb', 'https://api2.example.com/v2')
    await bump(ctx)
    const snap2 = await reg.getSnapshot(u.id)
    expect(snap2.version).toBe(snap1.version + 1)

    // 旧快照对象（进行中 run 持有）：内容仍单 provider；getModel 由旧快照驱动——
    // 重构造的参数取自快照冻结值（baseUrl/model 仍是旧配置），不感知 DB 变更
    expect(snap1.providers.map((p) => p.providerId)).toEqual(['pa'])
    await reg.getModel(snap1, 'pa')
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ model: 'a-1', baseUrl: 'https://api2.example.com/v1' })

    // 新快照：pb 可见
    expect(snap2.providers.map((p) => p.providerId)).toEqual(['pa', 'pb'])
  })

  it('版本变更丢缓存：新 key 重建实例', async () => {
    const u = await seedUser(ctx.prisma, 'rguser3', 'pw-rguser3-secure')
    await seedEndpoint(ctx, 'api3.example.com')
    await seedProvider(ctx, u.id, 'px', 'https://api3.example.com/v1')

    const { factory, calls } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-test', modelFactory: factory })

    const s1 = await reg.getSnapshot(u.id)
    await reg.getModel(s1, 'px')
    await bump(ctx)
    const s2 = await reg.getSnapshot(u.id)
    await reg.getModel(s2, 'px')
    expect(calls).toHaveLength(2) // version 变更 → 重建
    expect(calls[0]).toMatchObject({ model: 'm-1', baseUrl: 'https://api3.example.com/v1' })
    expect(calls[1]).toMatchObject({ lcProvider: 'openai' })
  })

  // ---------------- 白名单第二层（验收 ②的 registry 半面）----------------

  it('实例构造复验 origin：admin 直接改库绕过 CRUD 层（baseUrl 改到未白名单端点）→ 40042', async () => {
    const u = await seedUser(ctx.prisma, 'rguser4', 'pw-rguser4-secure')
    await seedEndpoint(ctx, 'good.example.com')
    await seedProvider(ctx, u.id, 'pg', 'https://good.example.com/v1')

    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-test', modelFactory: makeFakeFactory().factory })
    const snap = await reg.getSnapshot(u.id)
    await expect(reg.getModel(snap, 'pg')).resolves.toBeTruthy()

    // 模拟 admin 直接改库（绕过 ModelProviderService 的 CRUD 层校验）
    await ctx.prisma.modelProvider.update({
      where: { ownerId_providerId: { ownerId: u.id, providerId: 'pg' } },
      data: { baseUrl: 'https://evil.example.com/v1' },
    })
    await bump(ctx)
    const snap2 = await reg.getSnapshot(u.id)
    try {
      await reg.getModel(snap2, 'pg')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(EndpointNotAllowedError)
      expect((e as EndpointNotAllowedError).code).toBe(40042)
    }
  })

  it('构造失败不留坏缓存（白名单未命中后修复配置 → 可重新构造）', async () => {
    const u = await seedUser(ctx.prisma, 'rguser5', 'pw-rguser5-secure')
    await seedEndpoint(ctx, 'fix.example.com')
    // 直接改库路径建一条未命中行（不走 CRUD）
    await ctx.prisma.modelProvider.create({
      data: {
        ownerId: u.id,
        providerId: 'bad',
        lcProvider: 'openai',
        baseUrl: 'https://notwhitelisted.example.com/v1',
        credentialEnvId: 'LLM_API_KEY',
        authHeader: true,
        modelsJson: JSON.stringify([{ id: 'm-1' }]),
      },
    })
    const { factory, calls } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-test', modelFactory: factory })
    const snap = await reg.getSnapshot(u.id)
    await expect(reg.getModel(snap, 'bad')).rejects.toBeInstanceOf(EndpointNotAllowedError)
    expect(calls).toHaveLength(0)

    // 修复（改库 + bump）后重新构造成功
    await ctx.prisma.modelProvider.update({
      where: { ownerId_providerId: { ownerId: u.id, providerId: 'bad' } },
      data: { baseUrl: 'https://fix.example.com/v1' },
    })
    await bump(ctx)
    const snap2 = await reg.getSnapshot(u.id)
    await expect(reg.getModel(snap2, 'bad')).resolves.toBeTruthy()
  })

  it('fetch wrapper 按快照白名单装配：传入 factory 的是函数且对未白名单 origin 拒绝', async () => {
    const u = await seedUser(ctx.prisma, 'rguser6', 'pw-rguser6-secure')
    await seedEndpoint(ctx, 'fw.example.com')
    await seedProvider(ctx, u.id, 'pf', 'https://fw.example.com/v1')

    let captured: typeof fetch | undefined
    const factory: ChatModelFactory = async (_model, opts) => {
      captured = opts.fetch
      return { invoke: async () => ({}) } as unknown as BaseChatModel
    }
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-test', modelFactory: factory })
    const snap = await reg.getSnapshot(u.id)
    await reg.getModel(snap, 'pf')
    expect(typeof captured).toBe('function')
    // wrapper 行为与快照白名单一致：白名单 origin 放行（inner 被调）；未白名单拒绝 40042
    //（集合键派生与 registry 同源：effectivePort + originKey——规则单点收敛于 allowlist）
    const inner = vi.fn(async () => new Response('{}'))
    const allowed = new Set(
      snap.endpoints.map((e) => originKey({ scheme: e.scheme, host: e.host, port: effectivePort(e.scheme, e.port) })),
    )
    const wrapper = createWhitelistFetch(allowed, inner as unknown as typeof fetch)
    await expect(wrapper('https://fw.example.com/v1/chat')).resolves.toBeTruthy()
    expect(inner).toHaveBeenCalledTimes(1)
    await expect(wrapper('https://evil.example.com/v1/chat')).rejects.toMatchObject({ code: 40042 })
    expect(inner).toHaveBeenCalledTimes(1)
  })

  // ---------------- 凭证解析 ----------------

  it('共享 key 缺失 → 90003（LLM_NOT_CONFIGURED）', async () => {
    const u = await seedUser(ctx.prisma, 'rguser7', 'pw-rguser7-secure')
    await seedEndpoint(ctx, 'nokey.example.com')
    await seedProvider(ctx, u.id, 'pk', 'https://nokey.example.com/v1')
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: '', modelFactory: makeFakeFactory().factory })
    const snap = await reg.getSnapshot(u.id)
    await expect(reg.getModel(snap, 'pk')).rejects.toMatchObject({ code: 90003 })
  })

  it('credentialEnvId 非 LLM_API_KEY → 90003', async () => {
    const u = await seedUser(ctx.prisma, 'rguser8', 'pw-rguser8-secure')
    await seedEndpoint(ctx, 'envx.example.com')
    await ctx.prisma.modelProvider.create({
      data: {
        ownerId: u.id,
        providerId: 'pe',
        lcProvider: 'openai',
        baseUrl: 'https://envx.example.com/v1',
        credentialEnvId: 'SOMETHING_ELSE',
        authHeader: true,
        modelsJson: JSON.stringify([{ id: 'm-1' }]),
      },
    })
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-test', modelFactory: makeFakeFactory().factory })
    const snap = await reg.getSnapshot(u.id)
    await expect(reg.getModel(snap, 'pe')).rejects.toMatchObject({ code: 90003 })
  })

  // ---------------- 默认链派生（731 §6）----------------

  it('默认链：primary = 首 provider 首模型；fallbacks = 余序（withConfig 绑定换模型，实例共享）；单模型无 fallback 直接返回', async () => {
    const u = await seedUser(ctx.prisma, 'rguser9', 'pw-rguser9-secure')
    await seedEndpoint(ctx, 'chain.example.com')
    await seedProvider(ctx, u.id, 'p1', 'https://chain.example.com/a', 'openai', ['a1', 'a2'])
    await seedProvider(ctx, u.id, 'p2', 'https://chain.example.com/b', 'anthropic', ['b1'])

    const { factory, calls } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-test', modelFactory: factory })
    const snap = await reg.getSnapshot(u.id)

    const chain = (await reg.getDefaultModel(snap)) as unknown as {
      stubChain: string
      fallbacks: Array<{ stubModel: string }>
    }
    expect(chain.stubChain).toBe('a1')
    // fallbacks = a2（p1 第二模型，withConfig 绑定）+ b1（p2 首模型，共享实例本体）
    expect(chain.fallbacks.map((f) => f.stubModel)).toEqual(['a2', 'b1'])
    // 构造面：每 provider 一次（缓存实例共享，换模型不重构造）——731 §2.4 缓存 key 不含 model
    expect(calls.map((c) => c.model)).toEqual(['a1', 'b1'])
    expect(calls.map((c) => c.lcProvider)).toEqual(['openai', 'anthropic'])

    // 单模型场景：无 fallback 直接返回 primary 本体
    const solo = await seedUser(ctx.prisma, 'rguser10', 'pw-rguser10-secure')
    await seedEndpoint(ctx, 'solo.example.com')
    await seedProvider(ctx, solo.id, 'ps', 'https://solo.example.com/v1', 'openai', ['s1'])
    const snapSolo = await reg.getSnapshot(solo.id)
    const model = (await reg.getDefaultModel(snapSolo)) as unknown as { stubModel: string }
    expect(model.stubModel).toBe('s1')
  })

  it('模型引用不存在 → 40040；provider 无模型 → 40040', async () => {
    const u = await seedUser(ctx.prisma, 'rguser11', 'pw-rguser11-secure')
    await seedEndpoint(ctx, 'miss.example.com')
    await seedProvider(ctx, u.id, 'pm', 'https://miss.example.com/v1')
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-test', modelFactory: makeFakeFactory().factory })
    const snap = await reg.getSnapshot(u.id)
    await expect(reg.getModel(snap, 'nobody')).rejects.toMatchObject({ code: 40040 })
    // 无模型 provider（防御面：CRUD 层 zod 已保 ≥1，直改库路径兜底）
    await ctx.prisma.modelProvider.update({
      where: { ownerId_providerId: { ownerId: u.id, providerId: 'pm' } },
      data: { modelsJson: '[]' },
    })
    await bump(ctx)
    const snap2 = await reg.getSnapshot(u.id)
    await expect(reg.getModel(snap2, 'pm')).rejects.toMatchObject({ code: 40040 })
  })

  // ---------------- 模型级白名单机制面（731 §5.2 · Spec R3）----------------

  it('resolveModelRef：集合内放行；集合外/未知 provider 拒 40040 + 明示消息', async () => {
    const u = await seedUser(ctx.prisma, 'rgmr', 'pw-rgmr-secure')
    await seedEndpoint(ctx, 'mr.example.com')
    await seedProvider(ctx, u.id, 'pm1', 'https://mr.example.com/a', 'openai', ['m-a', 'm-b'])
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-test', modelFactory: makeFakeFactory().factory })
    const snap = await reg.getSnapshot(u.id)

    // 集合内：原样返回（#777 middleware 拿到 ref 后 withConfig 绑安全值）
    expect(resolveModelRef(snap, { providerId: 'pm1', modelId: 'm-b' })).toEqual({
      providerId: 'pm1',
      modelId: 'm-b',
    })
    // 集合外：40040 + 消息含模型名与集合语义（非防探测面——runner 内部调用方）
    try {
      resolveModelRef(snap, { providerId: 'pm1', modelId: 'rogue' })
      expect.unreachable()
    } catch (e) {
      expect((e as { code: number }).code).toBe(40040)
      expect((e as Error).message).toContain('rogue')
      expect((e as Error).message).toContain('集合外值拒绝')
    }
    // 未知 provider
    expect(() => resolveModelRef(snap, { providerId: 'nobody', modelId: 'm-a' })).toThrow(
      'provider 不在配置快照内',
    )
    // 换模型路径入口组合：resolveModelRef 通过后 getModel/withConfig 才合法——
    // 模拟 #777 middleware 的合法序列（集合内绑定可构造）
    const model = await reg.getModel(snap, 'pm1')
    expect(model).toBeTruthy()
  })

  // ---------------- 惰性 seed（迁移后新用户）----------------

  it('新用户零 provider：快照加载惰性物化默认 minimax 行（幂等，不重复）', async () => {
    const fresh = await seedUser(ctx.prisma, 'rgfresh', 'pw-rgfresh-secure')
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-test', modelFactory: makeFakeFactory().factory })
    const snap = await reg.getSnapshot(fresh.id)
    expect(snap.providers).toHaveLength(1)
    expect(snap.providers[0]).toMatchObject({
      providerId: 'minimax',
      lcProvider: 'anthropic',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      credentialEnvId: 'LLM_API_KEY',
    })
    expect(snap.providers[0].models[0]).toMatchObject({ id: 'MiniMax-M3' })
    // DB 行落下且确定性 id
    const row = await ctx.prisma.modelProvider.findFirst({ where: { ownerId: fresh.id } })
    expect(row!.id).toBe(`seed-mp-minimax-${fresh.id}`)
    // 再次快照（含并发首跑面）：仍一行
    await bump(ctx)
    const snap2 = await reg.getSnapshot(fresh.id)
    expect(snap2.providers).toHaveLength(1)
    expect(await ctx.prisma.modelProvider.count({ where: { ownerId: fresh.id } })).toBe(1)
  })

  // ---------------- 真工厂构造（无网络 smoke：initChatModel 惰性构造）----------------

  it('真工厂：openai 兼容 + anthropic 两 provider 经 initChatModel 构造（零网络）', async () => {
    const u = await seedUser(ctx.prisma, 'rgreal', 'pw-rgreal-secure')
    await seedEndpoint(ctx, 'real.example.com')
    await seedProvider(ctx, u.id, 'ro', 'https://real.example.com/v1', 'openai', ['glm-4'])
    await seedProvider(ctx, u.id, 'ra', 'https://real.example.com/anthropic', 'anthropic', ['claude-x'])
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-test' })
    const snap = await reg.getSnapshot(u.id)
    const mo = await reg.getModel(snap, 'ro')
    expect(mo).toBeTruthy()
    const ma = await reg.getModel(snap, 'ra')
    expect(ma).toBeTruthy()
    // 缓存命中：同 key 同实例
    expect(await reg.getModel(snap, 'ro')).toBe(mo)
  })

  // ---------------- authHeader 语义（731 §6 · Spec 评审 a1）----------------

  it('authHeader 贯穿：行值 true/false 原样进工厂 opts（默认 true）', async () => {
    const u = await seedUser(ctx.prisma, 'rgah', 'pw-rgah-secure')
    await seedEndpoint(ctx, 'ah.example.com')
    await seedProvider(ctx, u.id, 'ptrue', 'https://ah.example.com/a', 'anthropic', ['m1'])
    await ctx.prisma.modelProvider.create({
      data: {
        ownerId: u.id,
        providerId: 'pfalse',
        lcProvider: 'anthropic',
        baseUrl: 'https://ah.example.com/b',
        credentialEnvId: 'LLM_API_KEY',
        authHeader: false, // 直改库形态（CRUD wire 默认 true）
        modelsJson: JSON.stringify([{ id: 'm2' }]),
      },
    })
    const { factory, calls } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-test', modelFactory: factory })
    const snap = await reg.getSnapshot(u.id)
    await reg.getModel(snap, 'ptrue')
    await reg.getModel(snap, 'pfalse')
    expect(calls.map((c) => c.authHeader)).toEqual([true, false])
  })

  it('authHeader=true（anthropic）：Bearer-only——invoke 实测 Authorization: Bearer 且不带 x-api-key', async () => {
    const u = await seedUser(ctx.prisma, 'rgrl', 'pw-rgrl-secure')
    await seedEndpoint(ctx, 'rl.example.com')
    await seedProvider(ctx, u.id, 'pb', 'https://rl.example.com/anthropic', 'anthropic', ['MiniMax-M3'])
    // fetchImpl spy：捕获白名单 wrapper 放行的最终请求（Anthropic messages 响应形状）
    const seen: Array<Record<string, string>> = []
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>)
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'MiniMax-M3',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-real-test', fetchImpl })
    const snap = await reg.getSnapshot(u.id)
    const model = await reg.getModel(snap, 'pb')
    await model.invoke('hello')
    expect(seen.length).toBeGreaterThan(0)
    const headers = seen[0]!
    const flat: Record<string, string> = {}
    // Headers 实例或 plain object 两种形态归一
    if (typeof (headers as unknown as Headers).forEach === 'function') {
      ;(headers as unknown as Headers).forEach((v, k) => (flat[k.toLowerCase()] = v))
    } else {
      for (const [k, v] of Object.entries(headers)) flat[k.toLowerCase()] = String(v)
    }
    expect(flat['authorization']).toBe('Bearer sk-real-test')
    expect(flat['x-api-key']).toBeUndefined()
  })

  // ---------------- S1 串成：REST CRUD → version bump → 下个 run 快照生效（验收①字面）----------------

  it('S1 集成：REST 建 provider → config_meta bump → registry 下个 run 快照见新配置', async () => {
    const u = await seedUser(ctx.prisma, 'rgs1', 'pw-rgs1-secure')
    await seedEndpoint(ctx, 's1.example.com')
    const { factory } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-test', modelFactory: factory })

    // run N 快照：尚无 provider（新用户会惰性 seed 默认 minimax——本用例验证 REST 自建行）
    const before = await reg.getSnapshot(u.id)
    expect(before.providers.map((p) => p.providerId)).toEqual(['minimax']) // 惰性默认行

    // REST 面建 provider（信封级，走 ModelProviderService 全链：白名单校验 + version bump；
    // #857：owner 级路由，ownerId 直取认证身份）
    const l = await login(ctx.request, 'rgs1', 'pw-rgs1-secure')
    const res = await ctx.request
      .post('/api/v1/models/providers')
      .set(bearer(l.access))
      .send({
        provider_id: 'my-vllm',
        api: 'openai-completions',
        base_url: 'https://s1.example.com/v1',
        api_key_env_id: 'LLM_API_KEY',
        auth_header: true,
        models: [{ id: 'qwen3' }],
      })
    expect(res.body.code).toBe(0) // REST 全链过：白名单第一层 + 事务 version bump
    const v = await ctx.prisma.configMeta.findUnique({ where: { id: 1 } })
    expect(v).not.toBeNull()
    const after = await reg.getSnapshot(u.id)
    expect(after.version).toBe(before.version + 1)
    expect(after.providers.map((p) => p.providerId)).toEqual(['minimax', 'my-vllm'])
    // 新 provider 可构造（白名单第二层过）
    await expect(reg.getModel(after, 'my-vllm')).resolves.toBeTruthy()
  })
})
