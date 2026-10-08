// ProviderRegistry —— runner 侧 LLM 端点配置快照 + 模型实例注册表（#775 · #881 预设制换形）。
//
// 职责（731 §2.4 形状保留）：
//   ① run 粒度配置快照：run 启动调 getSnapshot（读 config_meta.version，微秒级 SQLite 读；
//     与内存版本不一致才重载——「不等才重载」）。进行中 run 持快照对象不感知后续变更
//     （run 内多轮 LLM 调用保持同一配置；配置变更下一 run 生效——#881 AC 保留语义）。
//   ② 模型实例缓存：key = (ownerId, providerId, configVersion)；版本变更丢缓存下 run 重建。
//   ③ 凭证解析双路径（#881）：BYOK 行 credentialCipher → AES-256-GCM 解密（失败 → 运行时
//     LLM_NOT_CONFIGURED）；cipher NULL / 平台虚拟条目 → 共享 LLM_API_KEY（缺失同码）。
//   ④ 平台默认端点虚拟条目（#881）：env 派生（config.llm：preset/model/apiKey），不落库，
//     恒追加快照垫底——零 provider 用户与默认链兜底都由它服务（per-user minimax 种子退役）。
//   ⑤ 默认链派生（不落盘）：用户端点序（createdAt）+ 平台垫底；primary = 首项首模型，
//     fallbacks = 余序，`.withFallbacks` 组合（731 §6 迁移映射）。
//
// 接缝：ModelFactory 可注入（测试 fake——真构造不打网络，fake 断言参数面）；prisma 经构造
// 注入。白名单双层校验 / fetch wrapper 随 #881 预设制退役（预设域 = 信任域，无自由地址）。

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { Runnable } from '@langchain/core/runnables'
import { RunnableBinding } from '@langchain/core/runnables'
import { initChatModel } from 'langchain/chat_models/universal'
import { Anthropic } from '@anthropic-ai/sdk'
import type { PrismaClient } from '../generated/prisma/client'
import { CODE } from '../codes'
import { fail } from '../envelope'
import { config } from '../config'
import { decryptCredential } from '../models/cipher'
import {
  PLATFORM_PROVIDER_ID,
  presetById,
  protocolToLcProvider,
  type PresetModelEntry,
} from '../models/presets'

// ---------------------------------------------------------------------------
// 快照形状
// ---------------------------------------------------------------------------

export interface ModelEntryLike {
  readonly id: string
  readonly [key: string]: unknown // name/reasoning/input/cost/contextWindow/maxTokens 等展示字段原样保留
}

// 快照内一条端点（BYOK 行的预设派生投影 / 平台虚拟条目）。
export interface ProviderSnapshotEntry {
  readonly providerId: string
  readonly lcProvider: 'openai' | 'anthropic'
  readonly baseUrl: string
  /** anthropic 协议面凭证头策略（预设派生）：true = Bearer；false = SDK 原生 x-api-key */
  readonly authHeader: boolean
  /** BYOK key 密文；null = 平台共享 key（含平台虚拟条目） */
  readonly credentialCipher: string | null
  readonly models: readonly ModelEntryLike[]
}

// run 粒度配置快照（run 启动取一次，run 期间只读）。
export interface ProviderConfigSnapshot {
  readonly ownerId: string
  readonly version: number // config_meta.version（快照时点）
  readonly providers: readonly ProviderSnapshotEntry[] // 用户行 createdAt asc + 平台垫底
}

// ---------------------------------------------------------------------------
// 模型工厂接缝
// ---------------------------------------------------------------------------

export interface ModelFactoryOptions {
  readonly lcProvider: 'openai' | 'anthropic'
  readonly baseUrl: string
  readonly apiKey: string
  /** fetch 注入缝（测试 spy；生产 = globalThis.fetch） */
  readonly fetch: typeof fetch
  /** 凭证头策略（预设派生）：true = 强制 Authorization: Bearer（MiniMax/DeepSeek anthropic
   * 兼容面通行 Bearer——repo 调研文档锁）；false = SDK 原生头策略（anthropic=x-api-key） */
  readonly authHeader: boolean
}

export type ChatModelFactory = (model: string, opts: ModelFactoryOptions) => Promise<BaseChatModel>

// 默认工厂：initChatModel 构造（provider 二值；OpenAI 兼容端点统一 openai + baseUrl——731 §2.1）。
// fetch 注入面（实测锁定）：openai → configuration.fetch（透传 OpenAI client 构造器）；
// anthropic → clientOptions.{baseURL, fetch}（透传 Anthropic SDK client，源码 spread 次序保证
// 显式 clientOptions.baseURL 覆盖 ANTHROPIC_BASE_URL 等环境变量）。
// authHeader=true（anthropic）：经 createClient 覆盖把 SDK 的 apiKey（X-Api-Key 头）置 null、
// authToken（Authorization: Bearer 头）置 key——Bearer-only（双头并存会被部分网关拒）。
const defaultFactory: ChatModelFactory = async (model, opts) => {
  if (opts.lcProvider === 'openai') {
    return (await initChatModel(model, {
      modelProvider: 'openai',
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl, // initChatModel 映射 → ChatOpenAI baseURL（实测验证）
      configuration: { fetch: opts.fetch },
    })) as unknown as BaseChatModel
  }
  return (await initChatModel(model, {
    modelProvider: 'anthropic',
    apiKey: opts.apiKey,
    clientOptions: { baseURL: opts.baseUrl, fetch: opts.fetch },
    ...(opts.authHeader
      ? {
          createClient: (options: ConstructorParameters<typeof Anthropic>[0]) =>
            new Anthropic({ ...options, apiKey: null, authToken: opts.apiKey }),
        }
      : {}),
  })) as unknown as BaseChatModel
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ProviderRegistryDeps {
  /** 平台共享 LLM key（平台虚拟条目 / cipher=NULL 行的解析值；缺省 config.llm.apiKey） */
  readonly llmApiKey?: string
  /** 平台默认端点预设 id（缺省 config.llm.preset） */
  readonly llmPreset?: string
  /** 平台默认端点单模型覆盖（缺省 config.llm.model；'' = 用预设 defaultModels） */
  readonly llmModel?: string
  /** BYOK 凭证解密密钥（缺省 config.llm.credentialSecret） */
  readonly credentialSecret?: string
  /** fetch 注入缝（测试 spy；缺省 globalThis.fetch） */
  readonly fetchImpl?: typeof fetch
  /** 模型工厂注入缝（测试 fake；缺省 initChatModel 真工厂） */
  readonly modelFactory?: ChatModelFactory
}

function decodeModels(raw: string): ModelEntryLike[] {
  try {
    const v: unknown = JSON.parse(raw)
    if (Array.isArray(v)) return v.filter((m): m is ModelEntryLike => !!m && typeof m === 'object')
  } catch {
    // 坏 JSON → 空模型列表（getModel 时按「无可用模型」拒）
  }
  return []
}

export class ProviderRegistry {
  private readonly llmApiKey: string
  private readonly llmPreset: string
  private readonly llmModel: string
  private readonly credentialSecret: string
  private readonly fetchImpl: typeof fetch
  private readonly factory: ChatModelFactory

  // 快照缓存（ownerId → snapshot）+ 全局版本观察哨（版本变更 → 全清：快照数小，正确性优先）。
  private readonly snapshots = new Map<string, ProviderConfigSnapshot>()
  private readonly modelCache = new Map<string, Promise<BaseChatModel>>()
  private lastGlobalVersion: number | null = null

  constructor(private readonly prisma: PrismaClient, deps: ProviderRegistryDeps = {}) {
    this.llmApiKey = deps.llmApiKey ?? config.llm.apiKey
    this.llmPreset = deps.llmPreset ?? config.llm.preset
    this.llmModel = deps.llmModel ?? config.llm.model
    this.credentialSecret = deps.credentialSecret ?? config.llm.credentialSecret
    this.fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch
    this.factory = deps.modelFactory ?? defaultFactory
  }

  // ---- ① run 粒度快照（热生效入口，731 §4 方案二）----
  async getSnapshot(ownerId: string): Promise<ProviderConfigSnapshot> {
    const version = await this.readConfigVersion()
    if (this.lastGlobalVersion !== version) {
      // 配置版本变更（端点 CRUD 同事务 bump）：丢全部快照与模型缓存——
      // 下个 run 重建；进行中 run 持旧快照对象/旧实例继续跑（run 粒度快照语义）。
      this.snapshots.clear()
      this.modelCache.clear()
      this.lastGlobalVersion = version
    }
    const cached = this.snapshots.get(ownerId)
    if (cached && cached.version === version) return cached
    const snapshot = await this.loadSnapshot(ownerId, version)
    this.snapshots.set(ownerId, snapshot)
    return snapshot
  }

  private async readConfigVersion(): Promise<number> {
    const row = await this.prisma.configMeta.findUnique({ where: { id: 1 } })
    return row?.version ?? 1 // 未迁移库无行：按基线 1（CRUD 侧 bump 会自建行）
  }

  private async loadSnapshot(ownerId: string, version: number): Promise<ProviderConfigSnapshot> {
    const rows = await this.prisma.modelProvider.findMany({
      where: { ownerId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const entries = rows
      .map((r) => this.rowToEntry(r))
      .filter((e): e is ProviderSnapshotEntry => e !== null)
    return {
      ownerId,
      version,
      providers: [...entries, this.platformEntry()],
    }
  }

  // 未知 presetId（预设清单随版收缩后的存量行）：fail-closed 跳过整条——绝不替换 origin
  // 形状（行内 BYOK 凭证不得发往用户未选定的服务商，#881 凭证封闭主旨）。管理面仍可见
  // （service.toView 只读展示，无 origin 接触）。/model 钉过该行的会话按集合外拒（40040）。
  private rowToEntry(r: {
    id: string
    providerId: string
    presetId: string
    credentialCipher: string | null
    modelsJson: string
  }): ProviderSnapshotEntry | null {
    const preset = presetById(r.presetId)
    if (!preset) {
      // eslint-disable-next-line no-console
      console.warn(`[runner] model_providers 行引用未知预设，快照跳过：id=${r.id} providerId=${r.providerId} presetId=${r.presetId}`)
      return null
    }
    return {
      providerId: r.providerId,
      lcProvider: protocolToLcProvider(preset.protocol),
      baseUrl: preset.baseUrl,
      authHeader: preset.authHeader,
      credentialCipher: r.credentialCipher,
      models: decodeModels(r.modelsJson),
    }
  }

  // 平台默认端点虚拟条目（env 派生，不落库，恒垫底）：LLM_MODEL 覆盖单模型，否则预设
  // defaultModels 全集。零 provider 用户由此服务；默认链兜底同源。
  // 预设兜底回退 minimax 仅覆盖测试注入非法值面——生产 readLlmPreset fail-fast 已守
  // （config import 即 throw），且平台条目无用户凭证（cipher 恒 NULL，平台共享 key）。
  private platformEntry(): ProviderSnapshotEntry {
    const preset = presetById(this.llmPreset) ?? presetById('minimax')!
    const models: readonly ModelEntryLike[] =
      this.llmModel !== ''
        ? [{ id: this.llmModel } as ModelEntryLike]
        : (preset.defaultModels as readonly PresetModelEntry[] as readonly ModelEntryLike[])
    return {
      providerId: PLATFORM_PROVIDER_ID,
      lcProvider: protocolToLcProvider(preset.protocol),
      baseUrl: preset.baseUrl,
      authHeader: preset.authHeader,
      credentialCipher: null, // 平台共享 key
      models,
    }
  }

  // ---- ②③ 模型实例（缓存 + 凭证双路径解析）----
  // 缓存 key = (ownerId, providerId, configVersion)（731 §2.4 原文——刻意不含 model）：
  // 每 provider 一个 ConfigurableModel 实例，默认模型 = modelsJson 首条；per-request 换模型
  // 走 invoke 时 configurable 参数 / withConfig 绑定，实例跨模型共享、凭证轮换经 version 重建。
  async getModel(snapshot: ProviderConfigSnapshot, providerId: string): Promise<BaseChatModel> {
    const entry = snapshot.providers.find((p) => p.providerId === providerId)
    if (!entry) throw fail(CODE.PROVIDER_NOT_FOUND)
    const defaultModel = entry.models[0]?.id
    if (!defaultModel) {
      throw fail(CODE.PROVIDER_NOT_FOUND, 'provider 无可用模型（models 为空）')
    }
    const key = `${snapshot.ownerId}|${providerId}|${snapshot.version}`
    const cached = this.modelCache.get(key)
    if (cached) return cached

    const constructing = this.constructModel(entry, defaultModel)
    this.modelCache.set(key, constructing)
    try {
      return await constructing
    } catch (e) {
      // 构造失败（凭证缺失/解密失败 90003 / 工厂异常）不留坏缓存
      this.modelCache.delete(key)
      throw e
    }
  }

  private async constructModel(entry: ProviderSnapshotEntry, model: string): Promise<BaseChatModel> {
    const apiKey = this.resolveApiKey(entry)
    return this.factory(model, {
      lcProvider: entry.lcProvider,
      baseUrl: entry.baseUrl,
      apiKey,
      fetch: this.fetchImpl,
      authHeader: entry.authHeader,
    })
  }

  // 凭证解析双路径（#881）：BYOK 密文 → 解密（失败 → 90003 运行时；管理面读不炸、列表
  // key_error 标记——service 层语义）；NULL → 平台共享 key（缺失 → 90003）。
  private resolveApiKey(entry: ProviderSnapshotEntry): string {
    if (entry.credentialCipher !== null) {
      try {
        const key = decryptCredential(entry.credentialCipher, this.credentialSecret)
        if (key !== '') return key
      } catch {
        // 落下方统一 90003（错钥/坏信封同语义）
      }
      throw fail(CODE.LLM_NOT_CONFIGURED, '端点凭证解密失败（LLM_CREDENTIAL_SECRET 轮换缺失或密文损坏）——请在模型页重设 key')
    }
    if (this.llmApiKey === '') {
      throw fail(CODE.LLM_NOT_CONFIGURED)
    }
    return this.llmApiKey
  }

  // ---- ④ 默认链派生（primary = 首项首模型；fallbacks = 余序；不落盘，731 §6）----
  // 端点序 = 用户行 createdAt asc + 平台垫底（#881：零配置用户链 = 平台单模型；BYOK 用户
  // 链 = 自己端点在前、平台兜底——「单端点配额耗尽也有退路」）。换模型经 withConfig 绑定
  //（ConfigurableModel 的 configurable 通道，实测请求体正确换 model）——同端点多模型共享
  // 缓存实例，仅绑定点不同。集合外 model 值须先过 resolveModelRef（731 §5.2 机制面）。
  async getDefaultModel(snapshot: ProviderConfigSnapshot, preferred?: ModelRef): Promise<Runnable> {
    const firstModelOf = (providerId: string): string | undefined =>
      snapshot.providers.find((p) => p.providerId === providerId)?.models[0]?.id
    const refs = snapshot.providers.flatMap((p) =>
      p.models.map((m) => ({ providerId: p.providerId, modelId: m.id })),
    )
    if (refs.length === 0) {
      throw fail(CODE.LLM_NOT_CONFIGURED, '无可用模型（provider/models 均为空）')
    }
    // 悬挂回落（#880 story 11「服务不中断」）：preferred 来自持久化会话行，指向已删端点/
    // 已从模型列表移除的模型是配置变更后的常态数据 → warn + 回落默认链（用户序 + 平台垫底）。
    // 区别于 agent 每轮选值的集合外硬拒（resolveModelRef §5.2，那才是编程错误面）。
    let pinned = preferred
    if (pinned) {
      try {
        resolveModelRef(snapshot, pinned)
      } catch {
        // eslint-disable-next-line no-console
        console.warn(`[runner] 会话模型偏好悬挂，回落默认链：providerId=${pinned!.providerId} modelId=${pinned!.modelId}`)
        pinned = undefined
      }
    }
    if (pinned) {
      const index = refs.findIndex(ref => ref.providerId === pinned!.providerId && ref.modelId === pinned!.modelId)
      // 不可达（resolveModelRef 已验成员资格）——显式挡住 findIndex=-1 时 splice(-1) 静默轮转
      // fallback 链（preferred 误置链尾 = 主备倒挂）。
      if (index < 0) throw fail(CODE.PROVIDER_NOT_FOUND, '偏好模型不在配置快照中')
      refs.unshift(...refs.splice(index, 1))
    }
    const [primary, ...rest] = refs
    const primaryModel = await this.getModel(snapshot, primary.providerId)
    const primaryBound =
      primary.modelId === firstModelOf(primary.providerId)
        ? primaryModel
        : primaryModel.withConfig({ configurable: { model: primary.modelId } })
    if (rest.length === 0) return primaryBound
    // 兜底成员逐个构造、失败跳过：构造期失败（凭证解密失败/平台 key 缺失 90003/工厂异常）
    // 发生在 withFallbacks 组合之前，fallback 语义救不了——尾置条目坏掉 = 没有兜底，不是
    // 全灭（健康 primary 照常起跑；BYOK 用户不应因平台 key 缺失而全链被拒）。
    const fallbacks: Runnable[] = []
    for (const r of rest) {
      try {
        const base = await this.getModel(snapshot, r.providerId)
        fallbacks.push(
          r.modelId === firstModelOf(r.providerId)
            ? base
            : base.withConfig({ configurable: { model: r.modelId } }),
        )
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[runner] 默认链兜底成员构造失败，跳过：providerId=${r.providerId} model=${r.modelId}`, e)
      }
    }
    if (fallbacks.length === 0) return primaryBound
    return withChainBindTools(primaryBound.withFallbacks({ fallbacks }), primaryBound, fallbacks)
  }

  // 观测面（测试/健康检查；非产品 API）。
  cachedModelCount(): number {
    return this.modelCache.size
  }
}

// ---------------------------------------------------------------------------
// fallback 链 bindTools 透传
// ---------------------------------------------------------------------------

// RunnableWithFallbacks 缺 bindTools（@langchain/core 实测：bind/withConfig 有、bindTools 无）
// ——deepagents AgentNode 的 bindTools helper 按 duck-typing 判模型（invoke + _streamResponseChunks，
// langchain agents/model.cjs isBaseChatModel），RunnableWithFallbacks 两者缺一即被拒
//（「must define bindTools」）。多成员默认链（用户端点 + 平台垫底，#881 起恒 ≥2）此前在此
// 必炸（v15 多 provider 用户同炸——预存缺陷，平台垫底使其全量必现）。
// 实例级补面：Object.create 继承 invoke/stream/withConfig 全调用面，再补 _streamResponseChunks
//（duck 判定存在性所需；仅重放 chain.stream 的 chunk 序列，runManager 直通语义不还原——
// 当前消费面只判存在性、不做直调）与 bindTools（逐成员经 bindMemberTools 绑定后重组链，
// 每成员保留各自凭证与模型绑定）。
export function withChainBindTools(
  chain: Runnable,
  primary: Runnable,
  fallbacks: readonly Runnable[],
): Runnable {
  const bound = Object.create(chain) as Runnable & {
    bindTools: (tools: unknown, kwargs?: unknown) => Runnable
    _streamResponseChunks: (messages: unknown, options?: unknown, runManager?: unknown) => AsyncGenerator<unknown>
  }
  bound.bindTools = (tools: unknown, kwargs?: unknown): Runnable => {
    const p = bindMemberTools(primary, tools, kwargs)
    const fs = fallbacks.map((f) => bindMemberTools(f, tools, kwargs))
    return withChainBindTools(p.withFallbacks({ fallbacks: fs }), p, fs)
  }
  bound._streamResponseChunks = async function* (messages: unknown, options?: unknown): AsyncGenerator<unknown> {
    for await (const chunk of await (chain as unknown as {
      stream: (m: unknown, o?: unknown) => Promise<AsyncIterable<unknown>>
    }).stream(messages, options)) {
      yield chunk
    }
  }
  return bound
}

// 单成员工具绑定，与 langchain `_simpleBindTools`（agents/utils.cjs）同构：
//   - chat model（bindTools 存在）→ 直绑；
//   - RunnableBinding（withConfig 绑定形态——/model 钉非首模型后的成员即此形，@langchain/core
//     实测 RunnableBinding.prototype 无 bindTools）→ 剥 .bound 递归绑定后按原 config/kwargs/
//     configFactories 重组（此前 `bindTools?.() ?? member` 对它静默保留未绑成员——primary/fallback
//     均可在正常用户操作下丢工具绑定，agent 全程无 tool_calls）；
//   - 两者皆非 → throw（默认链成员必须是可绑模型；静默保留未绑成员 = 会话静默残废）。
function bindMemberTools(member: Runnable, tools: unknown, kwargs?: unknown): Runnable {
  const m = member as Runnable & { bindTools?: (t: unknown, k?: unknown) => Runnable }
  if (typeof m.bindTools === 'function') return m.bindTools(tools, kwargs)
  if (RunnableBinding.isRunnableBinding(member)) {
    const rb = member as RunnableBinding<unknown, unknown>
    return new RunnableBinding({
      bound: bindMemberTools(rb.bound as Runnable, tools, kwargs),
      config: rb.config,
      kwargs: rb.kwargs,
      configFactories: rb.configFactories,
    }) as Runnable
  }
  throw new Error('默认链成员不可绑定工具（既非 chat model 也非 RunnableBinding 包装的模型）')
}

// ---------------------------------------------------------------------------
// 模型引用机制面（731 §5.2，文件级导出供 runService wrapModelCall middleware 直接消费）
// ---------------------------------------------------------------------------

export interface ModelRef {
  readonly providerId: string
  readonly modelId: string
}

// 选值域校验：agent 每轮选模型（wrapModelCall）的合法值集 = 配置快照内 modelsJson 的 id
// 集合（含平台虚拟条目）——集合外值在此拒绝（§5.2 原文「判定为编程错误而非白名单攻击，因为
// 快照本身就是边界」）。错误面 40040 + 明示消息（非防探测面：调用方是 runner 自己的
// middleware，不是外部探测者）。
export function resolveModelRef(snapshot: ProviderConfigSnapshot, ref: ModelRef): ModelRef {
  const entry = snapshot.providers.find((p) => p.providerId === ref.providerId)
  if (!entry) throw fail(CODE.PROVIDER_NOT_FOUND, '模型引用的 provider 不在配置快照内')
  if (!entry.models.some((m) => m.id === ref.modelId)) {
    throw fail(
      CODE.PROVIDER_NOT_FOUND,
      `模型 ${ref.modelId} 不在 provider ${ref.providerId} 的模型集合内（集合外值拒绝）`,
    )
  }
  return ref
}
