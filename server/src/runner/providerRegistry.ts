// ProviderRegistry —— runner 侧 provider 配置注册表（731 §2.4/§4/§5.1 / #775 F 节）。
//
// 职责收口（731 §2.4「自建薄封装」）：模型实例的构造时机 / 缓存 / 失效 / 白名单复验 / 凭证解析
// 全部归本类，不依赖 ConfigurableModel 的 cacheKey 语义（其 key 含 apiKey，凭证轮换时漂移不可控）。
//
// - 缓存 key = (ownerId, providerId, modelId, configVersion)——731 §2.4 key 骨架 (ownerId,
//   providerId, configVersion) 再加 modelId 实参（initChatModel(model, …) 绑定模型名，同 provider
//   不同模型不得共享实例）；失效语义不变：configVersion 变更 → 丢缓存 → 下个 run 重建。
// - 热生效 = config_meta 版本号 + run 粒度快照（731 §4）：ensureFresh 是 run 启动第一步——读版本
//   判等，相等直接用缓存；不等才重载（丢缓存 + 重读全量 endpoints + 该 owner providers）。
//   ensureFresh 返回不可变快照，run 持有到底：进行中 run 不感知变更（run 内多轮 LLM 调用同一
//   配置），配置变更延迟 = 下一个 run。不引消息总线、不做推送。
// - 白名单第二层（731 §5.1）：实例构造前复验 origin ∈ 快照 endpoints——防 admin 直改库绕过 API
//   层（第一层在 models/service.ts，90002 字段明细；本层未命中 → 40042）。模型实例经注入工厂
//   构造，工厂拿到的 fetch = 白名单 wrapper（runner/whitelistedFetch，验最终请求 origin +
//   redirect manual 禁随）。
// - 不引 langchain 依赖（协议同形镜像，#772 先例）：ChatModelHandle 对本类不透明，构造经注入的
//   ChatModelFactory Port——#777 runner 核心以 initChatModel（provider 二值 openai/anthropic，
//   OpenAI 兼容端点统一 openai + baseUrl）装真工厂；S3/S1 测试注入 fake 工厂。

import type { LcProvider, PrismaClient } from '../generated/prisma/client'
import { CODE } from '../codes'
import { fail } from '../envelope'
import { isOriginAllowed, parsedOriginAllowed, parseEndpointOrigin, type EndpointEntry } from '../models/endpointAllowlist'
import { decodeModelsJson } from '../models/values'
import { createWhitelistedFetch, type FetchLike } from './whitelistedFetch'

// 模型实例句柄：对 Registry 不透明（构造与缓存归本域，调用面归 runner 主票 #777）。留 object
// 宽位——fake 工厂返回普通对象、真实 LangChain BaseChatModel 天然可赋值。
export type ChatModelHandle = object

// 工厂构造请求：LangChain initChatModel 装配面的协议同形镜像（#777 按此接）。
export interface ChatModelRequest {
  lcProvider: LcProvider // 二值白名单 openai | anthropic（OpenAI 兼容端点统一 openai + baseUrl）
  modelId: string
  baseUrl: string
  apiKey: string
  authHeader: boolean // true = Authorization Bearer（openai）/ x-api-key（anthropic）默认形态
  fetch: FetchLike // 白名单 wrapper（origin 复验 + redirect manual 禁随）
}

export interface ChatModelFactory {
  createModel(req: ChatModelRequest): Promise<ChatModelHandle>
}

// 快照行（provider 配置的运行时投影；modelsJson 已解码）。只读——run 持有到底，禁止就地改。
export interface ProviderSnapshotRow {
  providerId: string
  lcProvider: LcProvider
  baseUrl: string
  credentialEnvId: string | null
  credentialCipher: string | null
  authHeader: boolean
  models: ReadonlyArray<Record<string, unknown>>
}

// run 粒度配置快照：ensureFresh 产物，run 生命周期内的唯一配置真值。
export interface ProviderSnapshot {
  ownerId: string
  version: number
  providers: ReadonlyArray<ProviderSnapshotRow>
  endpoints: ReadonlyArray<EndpointEntry>
}

export interface ProviderRegistryDeps {
  prisma: Pick<PrismaClient, 'configMeta' | 'modelProvider' | 'providerEndpoint'>
  factory: ChatModelFactory
  // 凭证解析（P0 共享 key）：credentialEnvId → env 真值。生产 = (name) => process.env[name]；
  // 测试注入。per-user key（credentialCipher）P1 启用，P0 拒绝（731 §6：P0 平移共享 key）。
  lookupEnv: (name: string) => string | undefined
}

export class ProviderRegistry {
  private version = -1 // 永不与 config_meta.version（≥1）初值判等 → 首 run 必重载
  private endpoints: EndpointEntry[] = []
  private owners = new Map<string, ProviderSnapshotRow[]>()
  private modelCache = new Map<string, ChatModelHandle>()

  constructor(private readonly deps: ProviderRegistryDeps) {}

  // run 启动第一步（731 §4）：读 config_meta.version 判等 → 不等才重载。SQLite 同机读，微秒级。
  // 版本变更：丢全部模型缓存 + owner 快照，重读全量 endpoints；owner providers 惰性重读（首 run
  // 触达该 owner 时）。进行中 run 不感知：它持有旧快照对象，后续 getModel 按旧快照配置重建实例
  // （缓存已丢 → 工厂再构造，配置仍取自旧快照），绝无中途换配置。
  async ensureFresh(ownerId: string): Promise<ProviderSnapshot> {
    const meta = await this.deps.prisma.configMeta.findUnique({ where: { id: 1 } })
    const version = meta?.version ?? 1
    if (version !== this.version) {
      this.modelCache.clear()
      this.owners.clear()
      const rows = await this.deps.prisma.providerEndpoint.findMany({
        select: { scheme: true, host: true, port: true },
      })
      this.endpoints = rows
      this.version = version
    }
    let providers = this.owners.get(ownerId)
    if (!providers) {
      const rows = await this.deps.prisma.modelProvider.findMany({
        where: { ownerId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      providers = rows.map((row) => ({
        providerId: row.providerId,
        lcProvider: row.lcProvider,
        baseUrl: row.baseUrl,
        credentialEnvId: row.credentialEnvId,
        credentialCipher: row.credentialCipher,
        authHeader: row.authHeader,
        models: decodeModelsJson(row.modelsJson),
      }))
      this.owners.set(ownerId, providers)
    }
    return { ownerId, version: this.version, providers, endpoints: this.endpoints }
  }

  // 取模型实例（白名单第二层复验在构造前）。快照由 run 启动时 ensureFresh 取得并持有。
  async getModel(snapshot: ProviderSnapshot, providerId: string, modelId: string): Promise<ChatModelHandle> {
    const row = snapshot.providers.find((p) => p.providerId === providerId)
    if (!row) throw fail(CODE.PROVIDER_NOT_FOUND)

    // 模型值域（731 §5.2）：选值域 = 配置快照内 modelsJson 的 id 集合，集合外拒绝（判定为编程
    // 错误而非白名单攻击——快照本身就是边界）。
    const knownIds = new Set(row.models.map((m) => String((m as { id?: unknown }).id ?? '')))
    if (!knownIds.has(modelId)) {
      throw fail(CODE.VALIDATION_FAILED, `model ${modelId} 不在 provider ${providerId} 的模型列表内`)
    }

    // 白名单第二层（731 §5.1）：实例构造前复验 origin ∈ 白名单。未命中 → 40042，不泄露白名单内容
    // （配置可能被 admin 直改库绕过 API 层的第一层校验——此处是最后防线）。
    const parsed = parseEndpointOrigin(row.baseUrl)
    if (!parsed || !parsedOriginAllowed(parsed, snapshot.endpoints)) {
      throw fail(CODE.PROVIDER_ENDPOINT_NOT_ALLOWED)
    }

    // 缓存 key = (ownerId, providerId, modelId, configVersion)（731 §2.4 key 骨架 + modelId 实参）。
    // JSON 元组序化：providerId 是 DNS-label、version 是整数，均不含引号/逗号歧义，元组编码杜绝
    // 分隔符注入式碰撞。
    const cacheKey = JSON.stringify([snapshot.ownerId, row.providerId, modelId, snapshot.version])
    const hit = this.modelCache.get(cacheKey)
    if (hit) return hit

    const apiKey = this.resolveApiKey(row)
    // 每实例白名单 fetch wrapper（isAllowed 闭包持快照 endpoints——run 粒度配置边界）。
    const whitelistedFetch = createWhitelistedFetch({
      isAllowed: (origin) => isOriginAllowed(origin, snapshot.endpoints),
    })
    const model = await this.deps.factory.createModel({
      lcProvider: row.lcProvider,
      modelId,
      baseUrl: row.baseUrl,
      apiKey,
      authHeader: row.authHeader,
      fetch: whitelistedFetch,
    })
    this.modelCache.set(cacheKey, model)
    return model
  }

  // 凭证解析（P0 共享 key；731 §3.2/§6）：credentialCipher 为 P1 预留列，P0 出现即拒（配置面
  // 不该有值）；credentialEnvId 缺省 LLM_API_KEY（对齐 seed 与 legacy 行为）；env 缺失 → 90003
  // （对齐既有 LLM key 未配置语义；run 语境下归错误三分类，#777）。
  private resolveApiKey(row: ProviderSnapshotRow): string {
    if (row.credentialCipher) {
      throw fail(CODE.LLM_NOT_CONFIGURED, 'per-user 凭证尚未启用（P1），当前仅支持共享 LLM_API_KEY')
    }
    const envId = row.credentialEnvId ?? 'LLM_API_KEY'
    const key = this.deps.lookupEnv(envId)
    if (!key) throw fail(CODE.LLM_NOT_CONFIGURED)
    return key
  }
}
