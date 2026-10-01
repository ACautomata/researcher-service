// ModelProviderService —— 每用户 model provider CRUD（#336；#771 归属上移；#775 事务简化）。
//
// #775（731 §4/§6）：LLM 调用收进控制面 runner 后，provider 配置的消费方从「容器内 OpenClaw」
// 变为「控制面 ProviderRegistry」——写盘（putArchive）/ catch reconcile / per-container 写锁 /
// 模板渲染整段退役，DB 即盘。事务语义简化为：DB mutation + config_meta version 同事务 +1
// （热生效信号，731 §4）——唯一性冲突 P2002 → 40041、目标行缺失 P2025 → 40040，失败即回滚，
// 无外部资源（fs）介入，不再有「DB 回滚但盘上已落盘」的发散面。
//
// 白名单第一层（731 §5.1，create/update 事务前）：base_url 的 origin 须命中 provider_endpoints
// 白名单（90002 字段级明细），DNS 解析私网/环回即拒（fail-closed）。第二层在 runner
// （providerRegistry 实例构造复验 + whitelistedFetch），未命中 40042。
//
// 归属前置（容器级 20040 防探测）由路由层 getInstanceForUser 完成，本服务只操作「已通过归属
// 校验的容器行」。provider 级「不存在 vs 越权」同码 40040（#336 验收）：非 owner 到不了 provider
// 级（容器门已挡），对外两者逐字节一致、区分仅进服务端日志。

import type { Container, ModelProvider, PrismaClient } from '../generated/prisma/client'
import { fail } from '../envelope'
import { CODE } from '../codes'
import {
  checkEndpointAllowed,
  nodeDnsLookup,
  type DnsLookup,
  type EndpointEntry,
} from './endpointAllowlist'
import { decodeModelsJson, LC_PROVIDER_TO_WIRE, WIRE_TO_LC_PROVIDER, type ProviderApiWire } from './values'

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

// 事务内只用到的 modelProvider / container / configMeta 投影（对齐 auth.rotateInTx 的
// Pick<PrismaClient,…> 接缝写法）；container 供 assertWritable 事务内重查状态谓词。
type ProviderTx = Pick<PrismaClient, 'modelProvider' | 'container' | 'configMeta'>

// 731 §3.2：credentialEnvId 过渡列可空（为 P1 per-user key 留位，见 credentialCipher）；
// legacy wire 契约要求 apiKeyEnvId 非空（zod 入站保证）——缺失时回退空串（旧行为不变）。
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
    models: decodeModelsJson(row.modelsJson),
    created_at: row.createdAt,
  }
}

// 热生效信号（731 §4）：provider/endpoint CRUD 同事务对单行计数器 +1；runner run 启动读版本
// 判等，不等才重载快照。upsert 兜底未种子行（incremental-schema INSERT OR IGNORE 种子 id=1）。
export async function bumpConfigVersion(tx: ProviderTx): Promise<void> {
  await tx.configMeta.upsert({
    where: { id: 1 },
    update: { version: { increment: 1 } },
    create: { id: 1, version: 2 }, // 新计数器首个变更后版本从 2 起步（种子基线 = 1）
  })
}

export class ModelProviderService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly resolveDns: DnsLookup = nodeDnsLookup,
  ) {}

  async list(inst: Container): Promise<ModelProviderView[]> {
    const rows = await this.prisma.modelProvider.findMany({
      where: { ownerId: inst.ownerId }, // #771 归属上移：行挂用户，同 owner 多容器共享配置面
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return rows.map(toView)
  }

  async get(inst: Container, pid: string): Promise<ModelProviderView> {
    return toView(await this.requireProvider(inst.ownerId, pid))
  }

  // 白名单第一层（731 §5.1「创建/更新时校验，事务前」）：origin 精确匹配 + DNS 私网/环回拒绝。
  // DNS 在事务外（可能慢查询，不占事务窗口）；失败 → 90002 + base_url 字段明细（非裸 500）。
  private async assertEndpointAllowed(baseUrl: string): Promise<void> {
    const endpoints: EndpointEntry[] = await this.prisma.providerEndpoint.findMany({
      select: { scheme: true, host: true, port: true },
    })
    const verdict = await checkEndpointAllowed({ baseUrl, endpoints, resolveDns: this.resolveDns })
    if (!verdict.ok) throw fail(CODE.VALIDATION_FAILED, undefined, { base_url: [verdict.message] })
  }

  async create(inst: Container, input: ModelProviderWriteInput): Promise<ModelProviderView> {
    await this.assertEndpointAllowed(input.baseUrl)
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await this.assertWritable(tx, inst.id)
        const created = await tx.modelProvider.create({
          data: {
            ownerId: inst.ownerId, // #771 归属上移（731 §3.2）
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

  async update(inst: Container, pid: string, input: ModelProviderWriteInput): Promise<ModelProviderView> {
    await this.assertEndpointAllowed(input.baseUrl)
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await this.assertWritable(tx, inst.id)
        // 复合唯一 where 定位目标行（路径 pid）：不存在 → P2025 → 40040。
        // data.providerId 可为新 pid（PUT 改 provider_id），撞同 owner 既有 pid → P2002 → 40041。
        const updated = await tx.modelProvider.update({
          where: { ownerId_providerId: { ownerId: inst.ownerId, providerId: pid } },
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
      this.rethrowKnown(e, { ownerId: inst.ownerId, pid })
    }
  }

  async remove(inst: Container, pid: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.assertWritable(tx, inst.id)
        await tx.modelProvider.delete({
          where: { ownerId_providerId: { ownerId: inst.ownerId, providerId: pid } },
        })
        await bumpConfigVersion(tx)
      })
    } catch (e) {
      this.rethrowKnown(e, { ownerId: inst.ownerId, pid })
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

  // 事务内状态谓词（#366 codex P2）：路由层 resolveWrite 的 creating/removing 检查基于请求前
  // 快照（check-then-act），事务内重查消除 TOCTOU。#775 写盘链退役后本谓词的原始理由（putArchive
  // 与删容器竞态）消失，检查保留——REST 契约稳定（creating/removing 拒写 20043 语义不变）+ 配置
  // 生命周期与容器生命周期解耦前的保守防御。
  // 行不存在（并发删完）与 creating/removing 同拒 20043。
  private async assertWritable(tx: ProviderTx, containerId: string): Promise<void> {
    const inst = await tx.container.findUnique({ where: { id: containerId } })
    if (!inst || inst.status === 'creating' || inst.status === 'removing') {
      throw fail(CODE.CONTAINER_BUSY, '容器正在创建/删除中，暂不能配置模型，请稍候')
    }
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
