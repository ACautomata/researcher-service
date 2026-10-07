// ModelProviderService —— 每用户 model provider CRUD + 热生效版本号（#336；#771 归属上移；#775 事务简化；
// #857 服务签名 ownerId 标量化：入参即操作主体，与容器行完全脱钩）。
//
// 事务语义（#775，731 §4/§6）：DB mutation + config_meta version bump 同一事务；写盘
// （putArchive 重渲染 openclaw.json）/ catch reconcile / per-container 写锁整段退役——
// LLM 调用的消费方已从「容器内 OpenClaw 进程」换为「控制面 runner」（#731 §1.3），配置变更经
// version 信号热生效（下一个 run 重建快照），不再有 fs 资源参与事务。configWriter/
// configBuilder 两文件已随 T0 清退（#801）。unique(ownerId, providerId) 并发冲突 → P2002 → 40041；
// 目标行缺失 → P2025 → 40040。
//
// 白名单第一层校验（#775，731 §5.1）：create/update 在事务前调 checkOriginForCrud——
// zod URL 形态（validation/schemas.ts）→ origin 精确匹配 provider_endpoints → DNS 私网/环回
// 拒绝（可注入 lookup 测 fake；ALLOW_PRIVATE_PROVIDER_ENDPOINTS 为自建私网端点逃生门）。
// 未命中 → 90002 字段级 base_url（不泄露白名单内容；40042 仅运行时第二层）。
//
// #771（731 §3.2）：归属 containerId → ownerId 上移（「用户」是配置主体，多容器共享同一 LLM
// 配置面）——行归属取 ownerId，unique 键随之 (ownerId, providerId)。
//
// #857（退役②）：归属前置不再经容器行解析——ownerId 由路由层从认证身份直派生传入，本服务
// 零容器行查询（事务内状态谓词 assertWritable 随 creating/removing 拒写契约一并移除）。
// provider 级「不存在 vs 越权」同码 40040（#336 验收）：非 owner 到不了目标行（ownerId 复合
// 定位天然隔离），对外两者逐字节一致、区分仅进服务端日志。

import type { ModelProvider, PrismaClient } from '../generated/prisma/client'
import { fail } from '../envelope'
import { CODE } from '../codes'
import { config } from '../config'
import {
  checkOriginForCrud,
  defaultHostLookup,
  OriginCheckError,
  type HostLookup,
} from '../runner/allowlist'
import { bumpConfigVersion } from './configVersion'
import { LC_PROVIDER_TO_WIRE, WIRE_TO_LC_PROVIDER, type ProviderApiWire } from './values'

// 写侧输入（路由层已把 snake_case body 经 zod 校验后映射为 camelCase domain shape）
export interface ModelProviderWriteInput {
  providerId: string
  api: ProviderApiWire
  baseUrl: string
  apiKeyEnvId: string
  authHeader: boolean
  models: Array<Record<string, unknown>>
}

// 读侧输出（snake_case wire，对齐 Django ModelProviderReadSerializer / 前端 models.ts）
export interface ModelProviderView {
  id: string
  provider_id: string
  api: ProviderApiWire
  base_url: string
  api_key_env_id: string
  auth_header: boolean
  models: Array<Record<string, unknown>>
  created_at: Date
}

// 白名单校验注入缝（#775）：lookup 测试注 fake 免真 DNS；allowPrivate 覆盖 env 开关。
// 缺省 = 生产形态（真 DNS + config 开关）。
export interface ModelProviderServiceOptions {
  lookup?: HostLookup
  allowPrivate?: boolean
}

// 防御解码 modelsJson（对齐 containers.decodeScopes）：坏 JSON 让 list 请求 500；合法 JSON 但
// 非数组也违反 models[] 响应契约 → 回退 []。
function decodeModels(raw: string): Array<Record<string, unknown>> {
  try {
    const v: unknown = JSON.parse(raw)
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>
  } catch {
    // 坏 JSON → 回退 []
  }
  return []
}

// 731 §3.2：credentialEnvId 过渡列可空（为 P1 per-user key 留位，见 credentialCipher）；
// legacy wire/落盘链要求 apiKeyEnvId 非空（zod 入站保证）——缺失时回退空串（旧行为不变）。
function envIdOf(row: ModelProvider): string {
  return row.credentialEnvId ?? ''
}

function toView(row: ModelProvider): ModelProviderView {
  return {
    id: row.id,
    provider_id: row.providerId,
    api: LC_PROVIDER_TO_WIRE[row.lcProvider],
    base_url: row.baseUrl,
    api_key_env_id: envIdOf(row),
    auth_header: row.authHeader,
    models: decodeModels(row.modelsJson),
    created_at: row.createdAt,
  }
}

export class ModelProviderService {
  private readonly lookup: HostLookup
  private readonly allowPrivate: boolean

  constructor(
    private readonly prisma: PrismaClient,
    opts: ModelProviderServiceOptions = {},
  ) {
    this.lookup = opts.lookup ?? defaultHostLookup
    this.allowPrivate = opts.allowPrivate ?? config.runner.allowPrivateProviderEndpoints
  }

  async list(ownerId: string): Promise<ModelProviderView[]> {
    const rows = await this.prisma.modelProvider.findMany({
      where: { ownerId }, // #771 归属上移：行挂用户；#857：ownerId 即认证身份直派生
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return rows.map(toView)
  }

  async get(ownerId: string, pid: string): Promise<ModelProviderView> {
    return toView(await this.requireProvider(ownerId, pid))
  }

  // create/update：白名单第一层校验（事务前，不经网络占用事务）→ 事务内 mutation + version bump。
  async create(ownerId: string, input: ModelProviderWriteInput): Promise<ModelProviderView> {
    await this.assertOriginAllowed(input.baseUrl)
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.modelProvider.create({
          data: {
            ownerId, // #771 归属上移（731 §3.2）；#857：直取认证身份
            providerId: input.providerId,
            lcProvider: WIRE_TO_LC_PROVIDER[input.api],
            baseUrl: input.baseUrl,
            credentialEnvId: input.apiKeyEnvId,
            authHeader: input.authHeader,
            modelsJson: JSON.stringify(input.models),
          },
        })
        await bumpConfigVersion(tx)
        return created
      })
      return toView(row)
    } catch (e) {
      this.rethrowKnown(e)
    }
  }

  async update(ownerId: string, pid: string, input: ModelProviderWriteInput): Promise<ModelProviderView> {
    await this.assertOriginAllowed(input.baseUrl)
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        // 复合唯一 where 定位目标行（路径 pid）：不存在 → P2025 → 40040。
        // data.providerId 可为新 pid（PUT 改 provider_id），撞同 owner 既有 pid → P2002 → 40041。
        const updated = await tx.modelProvider.update({
          where: { ownerId_providerId: { ownerId, providerId: pid } },
          data: {
            providerId: input.providerId,
            lcProvider: WIRE_TO_LC_PROVIDER[input.api],
            baseUrl: input.baseUrl,
            credentialEnvId: input.apiKeyEnvId,
            authHeader: input.authHeader,
            modelsJson: JSON.stringify(input.models),
          },
        })
        await bumpConfigVersion(tx)
        return updated
      })
      return toView(row)
    } catch (e) {
      this.rethrowKnown(e, { ownerId, pid })
    }
  }

  async remove(ownerId: string, pid: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.modelProvider.delete({
          where: { ownerId_providerId: { ownerId, providerId: pid } },
        })
        await bumpConfigVersion(tx)
      })
    } catch (e) {
      this.rethrowKnown(e, { ownerId, pid })
    }
  }

  // 白名单第一层校验（#775，731 §5.1）：未命中 / DNS 私网 → 90002 字段级 base_url。
  private async assertOriginAllowed(baseUrl: string): Promise<void> {
    const entries = await this.prisma.providerEndpoint.findMany()
    try {
      await checkOriginForCrud(baseUrl, entries, {
        lookup: this.lookup,
        allowPrivate: this.allowPrivate,
      })
    } catch (e) {
      if (e instanceof OriginCheckError) {
        throw fail(CODE.VALIDATION_FAILED, undefined, { base_url: [e.fieldMessage] })
      }
      throw e
    }
  }

  // 读目标行（ownerId + provider_id 复合定位）。不存在 → 40040（防探测，data 恒 null）。
  private async requireProvider(ownerId: string, pid: string): Promise<ModelProvider> {
    const row = await this.prisma.modelProvider.findFirst({
      where: { ownerId, providerId: pid },
    })
    if (!row) {
      // eslint-disable-next-line no-console
      console.warn(`[models] provider_not_found: ownerId=${ownerId} pid=${pid}`)
      throw fail(CODE.PROVIDER_NOT_FOUND)
    }
    return row
  }

  // 已知领域错误转译；其余按原样上抛。
  // ctx 供「不存在 vs 越权」的日志区分：对外逐字节同码 40040，区分仅进服务端日志（#336 验收）。
  private rethrowKnown(e: unknown, ctx?: { ownerId: string; pid: string }): never {
    const code = (e as { code?: string }).code
    // unique(ownerId, providerId) 并发绕校验 / 重复提交 → 40041（非裸 500）
    if (code === 'P2002') throw fail(CODE.PROVIDER_ID_CONFLICT)
    // 目标 provider 行缺失（update/delete，P2025）→ 40040
    if (code === 'P2025') {
      // eslint-disable-next-line no-console
      if (ctx) console.warn(`[models] provider_not_found: ownerId=${ctx.ownerId} pid=${ctx.pid}`)
      throw fail(CODE.PROVIDER_NOT_FOUND)
    }
    throw e
  }
}
