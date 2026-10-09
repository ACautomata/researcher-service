// ProviderRegistry 测试（#775 热生效 + #881 预设制换形：平台虚拟条目合成 / BYOK 凭证双路径 /
// 默认链平台垫底；白名单第二层 40042 与 fetch wrapper 随预设制退役）。
//
// 接缝（#880 Testing Decisions 主接缝②）：ModelFactory 注入 fake（断言参数面，零网络）；
// prisma 走 setupTestApp 临时库；凭证 AES 真实 round-trip（encryptCredential 造行）。
// 热生效语义（731 §4 方案二）：run 启动读 config_meta.version 判等——不等才重载；
// 进行中 run 持旧快照对象不感知（快照不可变性）。

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedUser } from './helpers'
import { ProviderRegistry, resolveModelRef, withChainBindTools, type ChatModelFactory } from '../src/runner/providerRegistry'
import { ModelProviderService } from '../src/models/service'
import { encryptCredential } from '../src/models/cipher'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { Runnable } from '@langchain/core/runnables'
import { RunnableLambda } from '@langchain/core/runnables'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import { ScriptedChatModel } from './runnerFakes'

const TEST_SECRET = 'registry-test-credential-secret-32chars!'

// 工具绑定间谍模型：ScriptedChatModel 子类，bindTools 记录入参后返回自身。
class BindSpyModel extends ScriptedChatModel {
  readonly bindCalls: unknown[] = []

  constructor() {
    super([new AIMessage('spy-ok')])
  }

  override bindTools(tools?: unknown): this {
    this.bindCalls.push(tools)
    return this
  }
}

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

async function seedByok(
  ctx: TestContext,
  ownerId: string,
  providerId: string,
  presetId: string,
  modelIds: string[],
  opts: { apiKey?: string; cipher?: string | null } = {},
): Promise<void> {
  const cipher =
    opts.cipher !== undefined
      ? opts.cipher
      : opts.apiKey !== undefined
        ? encryptCredential(opts.apiKey, TEST_SECRET)
        : null
  await ctx.prisma.modelProvider.create({
    data: {
      ownerId,
      providerId,
      presetId,
      credentialCipher: cipher,
      modelsJson: JSON.stringify(modelIds.map((id) => ({ id, name: id }))),
    },
  })
}

const bump = async (ctx: TestContext): Promise<void> => {
  await ctx.prisma.configMeta.upsert({ where: { id: 1 }, create: { id: 1, version: 2 }, update: { version: { increment: 1 } } })
}

describe('ProviderRegistry（#881 预设制：平台虚拟条目 + BYOK 凭证双路径）', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await setupTestApp()
    await ctx.prisma.configMeta.upsert({ where: { id: 1 }, create: { id: 1, version: 1 }, update: {} })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })
  afterEach(() => vi.restoreAllMocks())

  // ---------------- 平台虚拟条目（env 派生，不落库）----------------

  it('零 provider 用户：快照恰一条平台条目（minimax 形状 + MiniMax-M3 + 平台 key）', async () => {
    const u = await seedUser(ctx.prisma, 'rg-platform', 'pw-rg-platform-secure')
    const { factory, calls } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-platform', modelFactory: factory })

    const snap = await reg.getSnapshot(u.id)
    expect(snap.providers.map((p) => p.providerId)).toEqual(['platform'])
    const platform = snap.providers[0]!
    expect(platform.lcProvider).toBe('anthropic') // minimax 预设 anthropic 兼容面
    expect(platform.baseUrl).toBe('https://api.minimaxi.com/anthropic')
    expect(platform.authHeader).toBe(true)
    expect(platform.credentialCipher).toBeNull()
    expect(platform.models.map((m) => m.id)).toEqual(['MiniMax-M3'])

    // 零配置用户发消息走平台端点：factory 收到平台形状 + 平台 key
    const model = await reg.getModel(snap, 'platform')
    expect(model).toBeDefined()
    expect(calls).toEqual([
      { model: 'MiniMax-M3', lcProvider: 'anthropic', baseUrl: 'https://api.minimaxi.com/anthropic', apiKey: 'sk-platform', authHeader: true },
    ])
  })

  it('LLM_PRESET / LLM_MODEL env 派生：预设换形状、单模型覆盖', async () => {
    const u = await seedUser(ctx.prisma, 'rg-env', 'pw-rg-env-secure')
    const { factory, calls } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, {
      llmApiKey: 'sk-platform',
      llmPreset: 'anthropic',
      llmModel: 'claude-sonnet-5-5',
      modelFactory: factory,
    })
    const snap = await reg.getSnapshot(u.id)
    const platform = snap.providers[0]!
    expect(platform.baseUrl).toBe('https://api.anthropic.com')
    expect(platform.authHeader).toBe(false) // 官方原生 x-api-key
    expect(platform.models.map((m) => m.id)).toEqual(['claude-sonnet-5-5'])
    await reg.getModel(snap, 'platform')
    expect(calls[0]).toMatchObject({ model: 'claude-sonnet-5-5', lcProvider: 'anthropic', authHeader: false })
  })

  it('平台条目不落库（虚拟实体）：DB 零行也恒在快照', async () => {
    const u = await seedUser(ctx.prisma, 'rg-norow', 'pw-rg-norow-secure')
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-platform' })
    await reg.getSnapshot(u.id)
    expect(await ctx.prisma.modelProvider.count({ where: { ownerId: u.id } })).toBe(0)
  })

  // ---------------- BYOK 凭证双路径 ----------------

  it('BYOK cipher 行：factory 收到解密后明文（AES 真实 round-trip）', async () => {
    const u = await seedUser(ctx.prisma, 'rg-byok', 'pw-rg-byok-secure')
    await seedByok(ctx, u.id, 'my-ds', 'deepseek', ['deepseek-v4-flash'], { apiKey: 'sk-byok-plain' })
    const { factory, calls } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, {
      llmApiKey: 'sk-platform',
      credentialSecret: TEST_SECRET,
      modelFactory: factory,
    })
    const snap = await reg.getSnapshot(u.id)
    expect(snap.providers.map((p) => p.providerId)).toEqual(['my-ds', 'platform']) // 用户行在前平台垫底
    await reg.getModel(snap, 'my-ds')
    expect(calls[0]).toMatchObject({
      model: 'deepseek-v4-flash',
      lcProvider: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-byok-plain',
    })
  })

  it('cipher NULL BYOK 行：走平台共享 key；坏密文 → 运行时 90003（读不炸、运行报未配置）', async () => {
    const u = await seedUser(ctx.prisma, 'rg-cipher', 'pw-rg-cipher-secure')
    await seedByok(ctx, u.id, 'shared-key', 'kimi', ['kimi-k2'], { cipher: null })
    await seedByok(ctx, u.id, 'broken', 'zhipu', ['glm-4.6'], { cipher: 'v1:AAAA:BBBB:CCCC' })
    const { factory } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, {
      llmApiKey: 'sk-platform',
      credentialSecret: TEST_SECRET,
      modelFactory: factory,
    })
    const snap = await reg.getSnapshot(u.id)

    const ok = await reg.getModel(snap, 'shared-key')
    expect(ok).toBeDefined()
    // 坏密文：构造期 90003 LLM_NOT_CONFIGURED（信封可检出），不留坏缓存
    await expect(reg.getModel(snap, 'broken')).rejects.toMatchObject({ code: 90003 })
    expect(await ctx.prisma.modelProvider.count({ where: { ownerId: u.id } })).toBe(2) // 读路径未删行
  })

  it('平台 key 缺失：平台条目与 cipher NULL 行均运行时 90003', async () => {
    const u = await seedUser(ctx.prisma, 'rg-nokey', 'pw-rg-nokey-secure')
    await seedByok(ctx, u.id, 'shared', 'openai', ['gpt-5.1'], { cipher: null })
    const { factory } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: '', credentialSecret: TEST_SECRET, modelFactory: factory })
    const snap = await reg.getSnapshot(u.id)
    await expect(reg.getModel(snap, 'platform')).rejects.toMatchObject({ code: 90003 })
    await expect(reg.getModel(snap, 'shared')).rejects.toMatchObject({ code: 90003 })
  })

  // ---------------- 默认链（用户端点序 + 平台垫底）----------------

  it('默认链：零配置 = 平台单模型；BYOK 用户 = 自己端点在前、平台兜底', async () => {
    const uZero = await seedUser(ctx.prisma, 'rg-chain0', 'pw-rg-chain0-secure')
    const regZero = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-platform', modelFactory: makeFakeFactory().factory })
    const chainZero = (await regZero.getDefaultModel(await regZero.getSnapshot(uZero.id))) as unknown as {
      stubModel: string
      withFallbacks?: unknown
    }
    expect(chainZero.stubModel).toBe('MiniMax-M3') // 单项链：primary 直返（无 withFallbacks 包装）

    const u = await seedUser(ctx.prisma, 'rg-chain', 'pw-rg-chain-secure')
    await seedByok(ctx, u.id, 'first', 'openai', ['gpt-a'], { apiKey: 'sk-a' })
    await seedByok(ctx, u.id, 'second', 'anthropic', ['claude-b'], { apiKey: 'sk-b' })
    const reg = new ProviderRegistry(ctx.prisma, {
      llmApiKey: 'sk-platform',
      credentialSecret: TEST_SECRET,
      modelFactory: makeFakeFactory().factory,
    })
    const snap = await reg.getSnapshot(u.id)
    const chain = (await reg.getDefaultModel(snap)) as unknown as {
      stubChain: string
      fallbacks: Array<{ stubModel: string }>
    }
    expect(chain.stubChain).toBe('gpt-a') // primary = 首端点首模型
    expect(chain.fallbacks.map((f) => f.stubModel)).toEqual(['claude-b', 'MiniMax-M3']) // 平台垫底
  })

  it('/model 偏好：BYOK 模型与平台模型均可选；下一 run 生效（快照重载后 preferred 前置）', async () => {
    const u = await seedUser(ctx.prisma, 'rg-pref', 'pw-rg-pref-secure')
    await seedByok(ctx, u.id, 'mine', 'openai', ['m-1', 'm-2'], { apiKey: 'sk-m' })
    const { factory } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, {
      llmApiKey: 'sk-platform',
      credentialSecret: TEST_SECRET,
      modelFactory: factory,
    })
    const snap = await reg.getSnapshot(u.id)
    // BYOK 非首模型可选（resolveModelRef 集合内）
    resolveModelRef(snap, { providerId: 'mine', modelId: 'm-2' })
    // 平台模型可选
    resolveModelRef(snap, { providerId: 'platform', modelId: 'MiniMax-M3' })
    const chain = (await reg.getDefaultModel(snap, { providerId: 'mine', modelId: 'm-2' })) as unknown as {
      stubChain: string
      fallbacks: Array<{ stubModel: string }>
    }
    expect(chain.stubChain).toBe('m-2')
    expect(chain.fallbacks.map((f) => f.stubModel)).toEqual(['m-1', 'MiniMax-M3'])
  })

  it('悬挂会话偏好（端点已删/模型已移出列表）：warn + 回落平台默认，run 不中断（#880 story 11）', async () => {
    const u = await seedUser(ctx.prisma, 'rg-dangling', 'pw-rg-dangling-secure')
    await seedByok(ctx, u.id, 'mine', 'openai', ['m-1'], { apiKey: 'sk-m' })
    const { factory } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, {
      llmApiKey: 'sk-platform',
      credentialSecret: TEST_SECRET,
      modelFactory: factory,
    })
    const snap = await reg.getSnapshot(u.id)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 端点整行已删（偏好指向不存在的 provider）→ 回落平台默认
    const ghostModel = await reg.getDefaultModel(snap, { providerId: 'ghost', modelId: 'm' })
    expect(await ghostModel.invoke([])).toEqual({ content: 'fake:MiniMax-M3' })
    const removedModel = await reg.getDefaultModel(snap, { providerId: 'mine', modelId: 'm-gone' })
    expect(await removedModel.invoke([])).toEqual({ content: 'fake:MiniMax-M3' })
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  it('resolveModelRef：集合外模型/provider 拒 40040（平台条目同域校验）', async () => {
    const u = await seedUser(ctx.prisma, 'rg-ref', 'pw-rg-ref-secure')
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-platform' })
    const snap = await reg.getSnapshot(u.id)
    expect(() => resolveModelRef(snap, { providerId: 'platform', modelId: 'nope' })).toThrow(/集合外|不在/)
    expect(() => resolveModelRef(snap, { providerId: 'ghost', modelId: 'm' })).toThrow()
  })

  // ---------------- 热生效 + 在飞 run 隔离（#881 AC 保留语义）----------------

  it('快照按 version 判等：CRUD bump → 下个 run 见新配置；缓存跨 bump 失效', async () => {
    const u = await seedUser(ctx.prisma, 'rg-hot', 'pw-rg-hot-secure')
    const { factory } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, {
      llmApiKey: 'sk-platform',
      credentialSecret: TEST_SECRET,
      modelFactory: factory,
    })
    await seedByok(ctx, u.id, 'p1', 'openai', ['a-1'], { apiKey: 'sk-1' })
    const snap1 = await reg.getSnapshot(u.id)
    expect(snap1.version).toBe(1)
    expect(snap1.providers.map((p) => p.providerId)).toEqual(['p1', 'platform'])

    await reg.getModel(snap1, 'p1')
    expect(reg.cachedModelCount()).toBe(1)

    await seedByok(ctx, u.id, 'p2', 'kimi', ['b-1'], { apiKey: 'sk-2' })
    await bump(ctx)
    const snap2 = await reg.getSnapshot(u.id)
    expect(snap2.version).toBe(2)
    expect(snap2.providers.map((p) => p.providerId)).toEqual(['p1', 'p2', 'platform'])
    expect(reg.cachedModelCount()).toBe(0) // 版本变更丢缓存
  })

  it('在飞 run 不受配置变更影响：旧快照对象驱动 getModel 仍用旧配置（配置视图冻结）', async () => {
    const u = await seedUser(ctx.prisma, 'rg-flying', 'pw-rg-flying-secure')
    const { factory, calls } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, {
      llmApiKey: 'sk-platform',
      credentialSecret: TEST_SECRET,
      modelFactory: factory,
    })
    await seedByok(ctx, u.id, 'flying', 'openai', ['old-model'], { apiKey: 'sk-old' })
    const inflight = await reg.getSnapshot(u.id) // run 启动快照

    await seedByok(ctx, u.id, 'flying2', 'anthropic', ['new-model'], { apiKey: 'sk-new' })
    await bump(ctx)
    await reg.getSnapshot(u.id) // 触发版本翻新（在飞 run 之外的新 run 视角）

    // 在飞 run 继续用旧快照取模型：仍解析旧端点旧凭证（不感知后续变更）
    const model = await reg.getModel(inflight, 'flying')
    expect(model).toBeDefined()
    expect(calls.at(-1)).toMatchObject({ model: 'old-model', apiKey: 'sk-old' })
    expect(calls.some((c) => c.model === 'new-model')).toBe(false)
  })

  it('getModel：未知 providerId → 40040（显式选值仍拒绝）', async () => {
    const u = await seedUser(ctx.prisma, 'rg-ghost', 'pw-rg-ghost-secure')
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-platform' })
    const snap = await reg.getSnapshot(u.id)
    await expect(reg.getModel(snap, 'deleted-provider')).rejects.toMatchObject({ code: 40040 })
  })

  // ---------------- 坏数据 fail-closed（#881 code review P2）----------------

  it('未知 presetId 行：快照 fail-closed 跳过 + warn（凭证绝不发往替换 origin；访问同 40040）', async () => {
    const u = await seedUser(ctx.prisma, 'rg-stale', 'pw-rg-stale-secure')
    await ctx.prisma.modelProvider.create({
      data: {
        ownerId: u.id,
        providerId: 'stale-ep',
        presetId: 'removed-preset',
        credentialCipher: encryptCredential('sk-stale-user-key', TEST_SECRET),
        modelsJson: JSON.stringify([{ id: 'm-stale' }]),
      },
    })
    const { factory, calls } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, {
      llmApiKey: 'sk-platform',
      credentialSecret: TEST_SECRET,
      modelFactory: factory,
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const snap = await reg.getSnapshot(u.id)
    expect(snap.providers.map((p) => p.providerId)).toEqual(['platform']) // 未知预设行不入快照
    expect(calls).toEqual([]) // 工厂零调用——用户 key 不出库、不发往任何 origin
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('removed-preset'))).toBe(true)
    await expect(reg.getModel(snap, 'stale-ep')).rejects.toMatchObject({ code: 40040 })
  })

  // ---------------- 默认链兜底弹性（#881 code review P2）----------------

  it('默认链：兜底成员构造失败跳过不拖垮整链（BYOK 不依赖平台 key）', async () => {
    const u = await seedUser(ctx.prisma, 'rg-resilient', 'pw-rg-resilient-secure')
    await seedByok(ctx, u.id, 'own', 'openai', ['m-own'], { apiKey: 'sk-own' })
    const { factory } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, {
      llmApiKey: '', // 平台 key 缺失 → 平台兜底条目构造必 90003
      credentialSecret: TEST_SECRET,
      modelFactory: factory,
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {}) // 跳过 warn 噪声
    const snap = await reg.getSnapshot(u.id)
    const chain = (await reg.getDefaultModel(snap)) as unknown as {
      stubModel?: string
      stubChain?: string
      fallbacks?: unknown[]
    }
    expect(chain.stubModel).toBe('m-own') // 健康 primary 照常起跑（无兜底 → 裸 primary 直返）
    expect(chain.stubChain).toBeUndefined() // 兜底全灭 → 不做 withFallbacks 包装
  })

  it('默认链：全部成员构造失败才抛（零 provider + 平台 key 缺失 → 90003）', async () => {
    const u = await seedUser(ctx.prisma, 'rg-allfail', 'pw-rg-allfail-secure')
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: '', modelFactory: makeFakeFactory().factory })
    const snap = await reg.getSnapshot(u.id)
    await expect(reg.getDefaultModel(snap)).rejects.toMatchObject({ code: 90003 })
  })

  // ---------------- withChainBindTools（fallback 链工具绑定面）----------------

  it('withChainBindTools：RunnableBinding 成员（withConfig 绑模型形态）工具绑定经 .bound 解包不丢', async () => {
    const primaryBase = new BindSpyModel()
    const fallbackBase = new BindSpyModel()
    const fallbackBound = fallbackBase.withConfig({ configurable: { model: 'm-2' } }) // RunnableBinding
    const chain = withChainBindTools(
      primaryBase.withFallbacks({ fallbacks: [fallbackBound] }),
      primaryBase,
      [fallbackBound],
    ) as Runnable & { bindTools: (t: unknown) => Runnable }
    const tools = [{ name: 'execute' }]
    const bound = chain.bindTools(tools) as Runnable & {
      bindTools: (t: unknown) => Runnable
      _streamResponseChunks?: unknown
    }
    expect(primaryBase.bindCalls).toEqual([tools]) // primary 直绑
    expect(fallbackBase.bindCalls).toEqual([tools]) // 关键回归钉：RunnableBinding 成员不再静默未绑
    expect(typeof bound._streamResponseChunks).toBe('function') // duck 判定面保留
    expect(typeof bound.bindTools).toBe('function') // 绑定结果仍可续绑（deepagents 契约）
    // Object.create 继承面：invoke 仍走 RunnableWithFallbacks → primary
    const out = await bound.invoke([new HumanMessage('hi')])
    expect((out as AIMessage).content).toBe('spy-ok')
  })

  it('withChainBindTools：非模型成员显式 throw（不静默保留未绑成员）', () => {
    const primary = new BindSpyModel()
    const ghost = RunnableLambda.from(() => 'x') as unknown as Runnable // 无 bindTools 亦非 RunnableBinding
    const chain = withChainBindTools(primary.withFallbacks({ fallbacks: [ghost] }), primary, [ghost])
    expect(() =>
      (chain as unknown as { bindTools: (t: unknown) => unknown }).bindTools([]),
    ).toThrow(/不可绑定工具/)
  })

  it('默认链全链工具绑定：/model 钉非首模型后 primary=RunnableBinding，链上每成员都绑', async () => {
    const u = await seedUser(ctx.prisma, 'rg-bindall', 'pw-rg-bindall-secure')
    await seedByok(ctx, u.id, 'multi', 'openai', ['m-1', 'm-2'], { apiKey: 'sk-m' })
    const spies: BindSpyModel[] = []
    const reg = new ProviderRegistry(ctx.prisma, {
      llmApiKey: 'sk-platform',
      credentialSecret: TEST_SECRET,
      modelFactory: async (_model) => {
        const s = new BindSpyModel()
        spies.push(s)
        return s as unknown as BaseChatModel
      },
    })
    const snap = await reg.getSnapshot(u.id)
    // preferred 钉非首模型 → primary = withConfig 绑定形态（RunnableBinding）
    const chain = (await reg.getDefaultModel(snap, { providerId: 'multi', modelId: 'm-2' })) as Runnable & {
      bindTools: (t: unknown) => Runnable
    }
    const tools = ['t1']
    chain.bindTools(tools)
    expect(spies).toHaveLength(2) // multi 单实例（per-provider 缓存）+ 平台条目实例
    expect(spies[0]!.bindCalls).toEqual([tools, tools]) // primary（RunnableBinding 解包）+ fallback m-1 同实例
    expect(spies[1]!.bindCalls).toEqual([tools]) // 平台兜底成员
  })

  it('真工厂（initChatModel）构造面 duck-type 锁定：invoke + _streamResponseChunks 齐备', async () => {
    const u = await seedUser(ctx.prisma, 'rg-real', 'pw-rg-real-secure')
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-platform' }) // 缺省 = 真工厂
    const snap = await reg.getSnapshot(u.id)
    const model = await reg.getModel(snap, 'platform')
    expect(typeof model.invoke).toBe('function')
    expect(typeof (model as unknown as { _streamResponseChunks?: unknown })._streamResponseChunks).toBe(
      'function',
    )
  })

  // ---------------- 插件 LLM 指派入快照（#883 T3）----------------

  it('快照携带 pluginAssignments（pluginId → {providerId, modelId}；含 null 行）', async () => {
    const u = await seedUser(ctx.prisma, 'rg-assign', 'pw-rg-assign-secure')
    await seedByok(ctx, u.id, 'ep-1', 'openai', ['gpt-x'])
    await ctx.prisma.pluginLlmAssignment.createMany({ data: [
      { ownerId: u.id, pluginId: 'autofigure', providerId: 'ep-1', modelId: 'gpt-x' },
      { ownerId: u.id, pluginId: 'judge', providerId: 'platform', modelId: null },
      { ownerId: u.id, pluginId: 'follow-default', providerId: null, modelId: null },
    ] })
    const { factory } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-platform', credentialSecret: TEST_SECRET, modelFactory: factory })
    const snap = await reg.getSnapshot(u.id)
    expect(snap.pluginAssignments.get('autofigure')).toEqual({ providerId: 'ep-1', modelId: 'gpt-x' })
    expect(snap.pluginAssignments.get('judge')).toEqual({ providerId: 'platform', modelId: null })
    expect(snap.pluginAssignments.get('follow-default')).toEqual({ providerId: null, modelId: null })
  })

  it('无指派用户：pluginAssignments 空表（默认链语义不受影响）', async () => {
    const u = await seedUser(ctx.prisma, 'rg-noassign', 'pw-rg-noassign-secure')
    const { factory } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-platform', credentialSecret: TEST_SECRET, modelFactory: factory })
    const snap = await reg.getSnapshot(u.id)
    expect(snap.pluginAssignments.size).toBe(0)
  })

  it('指派行悬挂（引用已删端点）照常入快照——悬挂判定归解析面（llmToolPort 回落），不拒载', async () => {
    const u = await seedUser(ctx.prisma, 'rg-assign-dangle', 'pw-rg-assign-dangle-secure')
    await ctx.prisma.pluginLlmAssignment.create({ data: {
      ownerId: u.id, pluginId: 'autofigure', providerId: 'deleted-ep', modelId: 'm',
    } })
    const { factory } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-platform', credentialSecret: TEST_SECRET, modelFactory: factory })
    const snap = await reg.getSnapshot(u.id)
    expect(snap.pluginAssignments.get('autofigure')).toEqual({ providerId: 'deleted-ep', modelId: 'm' })
  })

  it('指派变更 bump 版本 → 快照重载拾取新行（热生效；旧快照对象不变——在飞 run 不受影响）', async () => {
    const u = await seedUser(ctx.prisma, 'rg-assign-hot', 'pw-rg-assign-hot-secure')
    await seedByok(ctx, u.id, 'ep-1', 'openai', ['gpt-x'])
    const { factory } = makeFakeFactory()
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-platform', credentialSecret: TEST_SECRET, modelFactory: factory })
    const first = await reg.getSnapshot(u.id)
    expect(first.pluginAssignments.size).toBe(0)
    await ctx.prisma.pluginLlmAssignment.create({ data: { ownerId: u.id, pluginId: 'autofigure', providerId: 'ep-1', modelId: 'gpt-x' } })
    await bump(ctx) // 指派事务内的 bump（REST 面行为；此处直写模拟）
    const second = await reg.getSnapshot(u.id)
    expect(second.pluginAssignments.get('autofigure')).toEqual({ providerId: 'ep-1', modelId: 'gpt-x' })
    expect(first.pluginAssignments.size).toBe(0) // 旧快照对象不可变
  })
  it('端点删除后：旧快照继续供 teammate 使用，新快照会话与 teammate 都回落平台默认', async () => {
    const u = await seedUser(ctx.prisma, 'rg-delete', 'pw-rg-delete-secure')
    await seedByok(ctx, u.id, 'deleted', 'openai', ['old-model'], { apiKey: 'sk-old' })
    await seedByok(ctx, u.id, 'remaining', 'openai', ['other-model'], { apiKey: 'sk-other' })
    const factory: ChatModelFactory = async (model) => new ScriptedChatModel([new AIMessage(model)], { loop: true })
    const reg = new ProviderRegistry(ctx.prisma, { llmApiKey: 'sk-platform', credentialSecret: TEST_SECRET, modelFactory: factory })
    const old = await reg.getSnapshot(u.id)
    await new ModelProviderService(ctx.prisma, TEST_SECRET).remove(u.id, 'deleted')
    const next = await reg.getSnapshot(u.id)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await (await reg.getTeammateModel(old, 'deleted')).invoke([])).content).toBe('old-model')
    expect((await (await reg.getTeammateModel(next, 'deleted')).invoke([])).content).toBe('MiniMax-M3')
    expect((await (await reg.getDefaultModel(next, { providerId: 'deleted', modelId: 'old-model' })).invoke([])).content).toBe('MiniMax-M3')
    expect(warn).toHaveBeenCalledTimes(2)
  })


})
