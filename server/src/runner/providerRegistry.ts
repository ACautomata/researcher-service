// ProviderRegistry —— runner 侧 provider 配置快照 + 模型实例注册表（#775 · #747 F 节 / 731 §2.4/§4）。
//
// 职责（731 §2.4「自建薄封装」原样落地）：
//   ① run 粒度配置快照：run 启动调 getSnapshot（读 config_meta.version，微秒级 SQLite 读；
//     与内存版本不一致才重载——「不等才重载」）。进行中 run 持快照对象不感知后续变更
//     （run 内多轮 LLM 调用保持同一配置，杜绝会话中途换模型的一致性问题；无消息总线）。
//   ② 模型实例缓存：key = (ownerId, providerId, configVersion)（不依赖 ConfigurableModel 的
//     cacheKey——其含 apiKey，凭证轮换时 key 漂移不可控）；版本变更丢缓存下 run 重建。
//   ③ 实例构造前过白名单（第二层复验——admin 直接改库可绕过 CRUD 层，构造点是最后防线；
//     未命中 → EndpointNotAllowedError 40042）+ 凭证解析（credentialEnvId → 共享 LLM_API_KEY）。
//   ④ 默认链派生（不落盘）：primary = 首 provider 首模型，fallbacks = 余序
//     （createdAt 序 × modelsJson 序），`.withFallbacks` 组合（731 §6 迁移映射）。
//   ⑤ fetch wrapper：白名单校验最终请求 origin + redirect manual 禁随（createWhitelistFetch），
//     经 configuration.fetch（openai）/ clientOptions.fetch（anthropic）注入 SDK client。
//
// 接缝：ModelFactory 可注入（测试 fake——真构造不打网络，但 fake 可断言参数面）；prisma 经
// 构造注入（setupTestApp 同款临时库）。本票（#775）交付 registry 本体；run 编排接线归 #777。

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { Runnable } from '@langchain/core/runnables'
import { initChatModel } from 'langchain/chat_models/universal'
import { Anthropic } from '@anthropic-ai/sdk'
import type { PrismaClient } from '../generated/prisma/client'
import { CODE } from '../codes'
import { fail } from '../envelope'
import { config } from '../config'
import {
  createWhitelistFetch,
  effectivePort,
  EndpointNotAllowedError,
  originInWhitelist,
  originKey,
  parseHttpOrigin,
  type EndpointEntry,
} from './allowlist'
import { materializeDefaultProvider } from './providerDefaults'

// ---------------------------------------------------------------------------
// 快照形状
// ---------------------------------------------------------------------------

export interface ModelEntryLike {
  readonly id: string
  readonly [key: string]: unknown // name/reasoning/input/cost/contextWindow/maxTokens 等展示字段原样保留
}

// 快照内一条 provider（model_providers 行的解码投影）。
export interface ProviderSnapshotEntry {
  readonly providerId: string
  readonly lcProvider: 'openai' | 'anthropic'
  readonly baseUrl: string
  readonly credentialEnvId: string | null
  readonly authHeader: boolean
  readonly models: readonly ModelEntryLike[]
}

// run 粒度配置快照（run 启动取一次，run 期间只读）。
export interface ProviderConfigSnapshot {
  readonly ownerId: string
  readonly version: number // config_meta.version（快照时点）
  readonly providers: readonly ProviderSnapshotEntry[] // createdAt asc（默认链派生序）
  readonly endpoints: readonly EndpointEntry[] // 白名单（第二层复验 + fetch wrapper 源）
}

// ---------------------------------------------------------------------------
// 模型工厂接缝
// ---------------------------------------------------------------------------

export interface ModelFactoryOptions {
  readonly lcProvider: 'openai' | 'anthropic'
  readonly baseUrl: string
  readonly apiKey: string
  /** 白名单 fetch wrapper（校验最终请求 origin + redirect manual；SDK client 装配点） */
  readonly fetch: typeof fetch
  /** authHeader 语义（731 §6 迁移映射保留列）：true = 强制 Authorization: Bearer（OpenClaw
   * 模板默认形态；MiniMax/DeepSeek anthropic 兼容面通行 Bearer——repo 调研文档锁）；false =
   * SDK 原生头策略（anthropic=x-api-key；openai 恒 Bearer 无消费面） */
  readonly authHeader: boolean
}

export type ChatModelFactory = (model: string, opts: ModelFactoryOptions) => Promise<BaseChatModel>

// 默认工厂：initChatModel 构造（provider 二值；OpenAI 兼容端点统一 openai + baseUrl——731 §2.1）。
// fetch 注入面（实测锁定）：openai → configuration.fetch（透传 OpenAI client 构造器）；
// anthropic → clientOptions.{baseURL, fetch}（透传 Anthropic SDK client，源码 spread 次序保证
// 显式 clientOptions.baseURL 覆盖 ANTHROPIC_BASE_URL 等环境变量）。
// authHeader=true（anthropic）：经 createClient 覆盖把 SDK 的 apiKey（X-Api-Key 头）置 null、
// authToken（Authorization: Bearer 头）置 key——Bearer-only（双头并存会被部分网关拒；真
// Anthropic 官方 Bearer 路径 + MiniMax/DeepSeek 兼容面均接受 Bearer，repo 调研文档锁）。
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
  /** 共享 LLM key（credentialEnvId='LLM_API_KEY' 的解析值；缺省 config.runner.llmApiKey） */
  readonly llmApiKey?: string
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
  private readonly fetchImpl: typeof fetch
  private readonly factory: ChatModelFactory

  // 快照缓存（ownerId → snapshot）+ 全局版本观察哨（版本变更 → 全清：快照数小，正确性优先）。
  private readonly snapshots = new Map<string, ProviderConfigSnapshot>()
  private readonly modelCache = new Map<string, Promise<BaseChatModel>>()
  private lastGlobalVersion: number | null = null

  constructor(private readonly prisma: PrismaClient, deps: ProviderRegistryDeps = {}) {
    this.llmApiKey = deps.llmApiKey ?? config.runner.llmApiKey
    this.fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch
    this.factory = deps.modelFactory ?? defaultFactory
  }

  // ---- ① run 粒度快照（热生效入口，731 §4 方案二）----
  async getSnapshot(ownerId: string): Promise<ProviderConfigSnapshot> {
    const version = await this.readConfigVersion()
    if (this.lastGlobalVersion !== version) {
      // 配置版本变更（provider/endpoint CRUD 同事务 bump）：丢全部快照与模型缓存——
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
    let rows = await this.prisma.modelProvider.findMany({
      where: { ownerId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    if (rows.length === 0) {
      // 新用户惰性物化默认 provider（迁移脚本同构行；「空 providers → 模板默认」显式化）
      await materializeDefaultProvider(this.prisma, ownerId)
      rows = await this.prisma.modelProvider.findMany({
        where: { ownerId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    }
    const endpoints = await this.prisma.providerEndpoint.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return {
      ownerId,
      version,
      providers: rows.map((r) => ({
        providerId: r.providerId,
        lcProvider: r.lcProvider,
        baseUrl: r.baseUrl,
        credentialEnvId: r.credentialEnvId,
        authHeader: r.authHeader,
        models: decodeModels(r.modelsJson),
      })),
      endpoints: endpoints.map((e) => ({ scheme: e.scheme, host: e.host, port: e.port })),
    }
  }

  // ---- ②③ 模型实例（缓存 + 白名单第二层复验 + 凭证解析 + fetch wrapper 装配）----
  // 缓存 key = (ownerId, providerId, configVersion)（731 §2.4 原文——刻意不含 model）：
  // 每 provider 一个 ConfigurableModel 实例，默认模型 = modelsJson 首条；per-request 换模型
  // 走 invoke 时 configurable 参数 / withConfig 绑定（ConfigurableModel 内建，实测请求体
  // 正确换 model），实例跨模型共享、凭证轮换经 version 重建。
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

    const constructing = this.constructModel(snapshot, entry, defaultModel)
    this.modelCache.set(key, constructing)
    try {
      return await constructing
    } catch (e) {
      // 构造失败（白名单未命中 40042 / 凭证缺失 90003 / 工厂异常）不留坏缓存
      this.modelCache.delete(key)
      throw e
    }
  }

  private async constructModel(
    snapshot: ProviderConfigSnapshot,
    entry: ProviderSnapshotEntry,
    model: string,
  ): Promise<BaseChatModel> {
    // 白名单第二层复验（防 admin 直接改库绕过 CRUD 层）——未命中 40042（运行时错误面，
    // 与 CRUD 层 90002 字段级刻意分层，731 §5.1）。
    let origin: ReturnType<typeof parseHttpOrigin>
    try {
      origin = parseHttpOrigin(entry.baseUrl)
    } catch {
      throw new EndpointNotAllowedError('端点 URL 非法，请求被拒绝')
    }
    if (!originInWhitelist(origin, snapshot.endpoints)) {
      throw new EndpointNotAllowedError()
    }
    // 凭证解析（P0 共享 key：credentialEnvId 过渡列 → env 单一来源；P1 per-user credentialCipher）
    const apiKey = this.resolveApiKey(entry)
    // fetch wrapper 按快照白名单闭包（进行中 run 白名单变更不影响在飞实例——run 粒度快照）
    const allowed = new Set(snapshot.endpoints.map((e) => originKey({
      scheme: e.scheme,
      host: e.host,
      port: effectivePort(e.scheme, e.port), // NULL port 按 scheme 默认补齐（allowlist 同源）
    })))
    const guardedFetch = createWhitelistFetch(allowed, this.fetchImpl)
    return this.factory(model, {
      lcProvider: entry.lcProvider,
      baseUrl: entry.baseUrl,
      apiKey,
      fetch: guardedFetch,
      authHeader: entry.authHeader,
    })
  }

  private resolveApiKey(entry: ProviderSnapshotEntry): string {
    if (entry.credentialEnvId !== 'LLM_API_KEY') {
      throw fail(CODE.LLM_NOT_CONFIGURED, 'credentialEnvId 非法（当前仅支持 LLM_API_KEY）')
    }
    if (this.llmApiKey === '') {
      throw fail(CODE.LLM_NOT_CONFIGURED)
    }
    return this.llmApiKey
  }

  // ---- ④ 默认链派生（primary = 首 provider 首模型；fallbacks = 余序；不落盘，731 §6）----
  // 换模型经 withConfig 绑定（ConfigurableModel 的 configurable 通道，实测请求体正确换 model）——
  // 同 provider 多模型共享缓存实例，仅绑定点不同。集合外 model 值须先过 resolveModelRef
  //（731 §5.2 机制面，见文件级导出）。
  async getDefaultModel(snapshot: ProviderConfigSnapshot): Promise<Runnable> {
    const firstModelOf = (providerId: string): string | undefined =>
      snapshot.providers.find((p) => p.providerId === providerId)?.models[0]?.id
    const refs = snapshot.providers.flatMap((p) =>
      p.models.map((m) => ({ providerId: p.providerId, modelId: m.id })),
    )
    if (refs.length === 0) {
      throw fail(CODE.LLM_NOT_CONFIGURED, '无可用模型（provider/models 均为空）')
    }
    const [primary, ...rest] = refs
    const primaryModel = await this.getModel(snapshot, primary.providerId)
    const primaryBound =
      primary.modelId === firstModelOf(primary.providerId)
        ? primaryModel
        : primaryModel.withConfig({ configurable: { model: primary.modelId } })
    if (rest.length === 0) return primaryBound
    const fallbacks = await Promise.all(
      rest.map(async (r) => {
        const base = await this.getModel(snapshot, r.providerId)
        return r.modelId === firstModelOf(r.providerId)
          ? base
          : base.withConfig({ configurable: { model: r.modelId } })
      }),
    )
    return primaryBound.withFallbacks({ fallbacks })
  }

  // 观测面（测试/健康检查；非产品 API）。
  cachedModelCount(): number {
    return this.modelCache.size
  }
}

// ---------------------------------------------------------------------------
// 模型级白名单机制面（731 §5.2，文件级导出供 #777 wrapModelCall middleware 直接消费）
// ---------------------------------------------------------------------------

export interface ModelRef {
  readonly providerId: string
  readonly modelId: string
}

// 选值域校验：agent 每轮选模型（wrapModelCall）的合法值集 = 配置快照内 modelsJson 的 id
// 集合——集合外值在此拒绝（§5.2 原文「判定为编程错误而非白名单攻击，因为快照本身就是
// 边界；无需单独的模型白名单表」）。错误面 40040 + 明示消息（非防探测面：调用方是
// runner 自己的 middleware，不是外部探测者）。
export function resolveModelRef(snapshot: ProviderConfigSnapshot, ref: ModelRef): ModelRef {
  const entry = snapshot.providers.find((p) => p.providerId === ref.providerId)
  if (!entry) throw fail(CODE.PROVIDER_NOT_FOUND, '模型引用的 provider 不在配置快照内')
  if (!entry.models.some((m) => m.id === ref.modelId)) {
    throw fail(
      CODE.PROVIDER_NOT_FOUND,
      `模型 ${ref.modelId} 不在 provider ${ref.providerId} 的 modelsJson 集合内（集合外值拒绝）`,
    )
  }
  return ref
}
