// ModelProviderService —— 每容器 model provider CRUD + 写后重渲染（#336）。
//
// 事务语义（对齐 Django models/views._save_and_rewrite / _delete_and_rewrite）：
//   DB mutation（tx）+ 读 tx 全量 providers + writer.rewrite 在同一事务内 —— rewrite 写盘失败
//   抛 ConfigWriteError → 事务回滚 DB 行（90003），DB 与盘上配置绝不发散；
//   unique(containerId, providerId) 并发冲突 → P2002 → 40041；目标行缺失 → P2025 → 40040。
//
// 归属前置（容器级 20040 防探测）由路由层 getInstanceForUser 完成，本服务只操作「已通过归属
// 校验的容器行」。provider 级「不存在 vs 越权」同码 40040（#336 验收）：非 owner 到不了 provider
// 级（容器门已挡），对外两者逐字节一致、区分仅进服务端日志。

import type { Container, ModelProvider, PrismaClient } from '../generated/prisma/client'
import { ConfigWriteError } from '../containers/configStore'
import { fail } from '../envelope'
import { CODE } from '../codes'
import { type ProviderSpec } from './configBuilder'
import type { ModelConfigWriter } from './configWriter'
import { API_ENUM_TO_WIRE, WIRE_TO_API_ENUM, type ProviderApiWire } from './values'

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

// 事务内只用到 modelProvider 的投影（对齐 auth.rotateInTx 的 Pick<PrismaClient,…> 接缝写法）
type ProviderTx = Pick<PrismaClient, 'modelProvider'>

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

function toSpec(row: ModelProvider): ProviderSpec {
  return {
    providerId: row.providerId,
    api: API_ENUM_TO_WIRE[row.api],
    baseUrl: row.baseUrl,
    apiKeyEnvId: row.apiKeyEnvId,
    authHeader: row.authHeader,
    models: decodeModels(row.modelsJson),
  }
}

function toView(row: ModelProvider): ModelProviderView {
  return {
    id: row.id,
    provider_id: row.providerId,
    api: API_ENUM_TO_WIRE[row.api],
    base_url: row.baseUrl,
    api_key_env_id: row.apiKeyEnvId,
    auth_header: row.authHeader,
    models: decodeModels(row.modelsJson),
    created_at: row.createdAt,
  }
}

export class ModelProviderService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly writer: ModelConfigWriter,
  ) {}

  async list(inst: Container): Promise<ModelProviderView[]> {
    const rows = await this.prisma.modelProvider.findMany({
      where: { containerId: inst.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return rows.map(toView)
  }

  async get(inst: Container, pid: string): Promise<ModelProviderView> {
    return toView(await this.requireProvider(inst.id, pid))
  }

  // create/update/delete 共用事务骨架：
  //   tx 内做 DB mutation → 读 tx 全量 providers → writer.rewrite。
  //   rewrite 写盘失败抛 ConfigWriteError → 事务回滚（DB 行不留 orphan）；P2002/P2025 同路径转译。
  // #366 修复（codex P1「事务超时分裂」）：显式 timeout——Prisma 交互式事务默认 5s，rewrite 含
  // fs 写盘（慢卷/锁时可能超 5s），超时后 DB 回滚但 fs 操作不可取消仍可能落盘 → 盘上配置领先
  // DB 发散。显式 30s 让写盘有足够时间完成；回滚只发生在写盘真失败（fs 已失败未落盘）。
  async create(inst: Container, input: ModelProviderWriteInput): Promise<ModelProviderView> {
    try {
      const row = await this.prisma.$transaction(
        async (tx) => {
          const created = await tx.modelProvider.create({
            data: {
              containerId: inst.id,
              providerId: input.providerId,
              api: WIRE_TO_API_ENUM[input.api],
              baseUrl: input.baseUrl,
              apiKeyEnvId: input.apiKeyEnvId,
              authHeader: input.authHeader,
              modelsJson: JSON.stringify(input.models),
            },
          })
          await this.rewrite(tx, inst)
          return created
        },
        { timeout: 30_000 },
      )
      return toView(row)
    } catch (e) {
      this.rethrowKnown(e)
    }
  }

  async update(inst: Container, pid: string, input: ModelProviderWriteInput): Promise<ModelProviderView> {
    try {
      const row = await this.prisma.$transaction(
        async (tx) => {
          // 复合唯一 where 定位目标行（路径 pid）：不存在 → P2025 → 40040。
          // data.providerId 可为新 pid（PUT 改 provider_id），撞同容器既有 pid → P2002 → 40041。
          const updated = await tx.modelProvider.update({
            where: { containerId_providerId: { containerId: inst.id, providerId: pid } },
            data: {
              providerId: input.providerId,
              api: WIRE_TO_API_ENUM[input.api],
              baseUrl: input.baseUrl,
              apiKeyEnvId: input.apiKeyEnvId,
              authHeader: input.authHeader,
              modelsJson: JSON.stringify(input.models),
            },
          })
          await this.rewrite(tx, inst)
          return updated
        },
        { timeout: 30_000 },
      )
      return toView(row)
    } catch (e) {
      this.rethrowKnown(e, { containerId: inst.id, pid })
    }
  }

  async remove(inst: Container, pid: string): Promise<void> {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.modelProvider.delete({
            where: { containerId_providerId: { containerId: inst.id, providerId: pid } },
          })
          await this.rewrite(tx, inst)
        },
        { timeout: 30_000 },
      )
    } catch (e) {
      this.rethrowKnown(e, { containerId: inst.id, pid })
    }
  }

  // 读目标行（containerId + provider_id 复合定位）。不存在 → 40040（防探测，data 恒 null）。
  private async requireProvider(containerId: string, pid: string): Promise<ModelProvider> {
    const row = await this.prisma.modelProvider.findFirst({
      where: { containerId, providerId: pid },
    })
    if (!row) {
      // eslint-disable-next-line no-console
      console.warn(`[models] provider_not_found: containerId=${containerId} pid=${pid}`)
      throw fail(CODE.PROVIDER_NOT_FOUND)
    }
    return row
  }

  private async rewrite(tx: ProviderTx, inst: Container): Promise<void> {
    const rows = await tx.modelProvider.findMany({
      where: { containerId: inst.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    await this.writer.rewrite({ name: inst.name, id: inst.id, providers: rows.map(toSpec) })
  }

  // 已知领域错误转译；其余按原样上抛（ConfigurationError 90003 走错误面 ContainerDomainError 分支）。
  // ctx 供「不存在 vs 越权」的日志区分：对外逐字节同码 40040，区分仅进服务端日志（#336 验收）。
  private rethrowKnown(e: unknown, ctx?: { containerId: string; pid: string }): never {
    const code = (e as { code?: string }).code
    // unique(containerId, providerId) 并发绕校验 / 重复提交 → 40041（非裸 500）
    if (code === 'P2002') throw fail(CODE.PROVIDER_ID_CONFLICT)
    // 目标 provider 行缺失（update/delete，P2025）→ 40040
    if (code === 'P2025') {
      // eslint-disable-next-line no-console
      if (ctx) console.warn(`[models] provider_not_found: containerId=${ctx.containerId} pid=${ctx.pid}`)
      throw fail(CODE.PROVIDER_NOT_FOUND)
    }
    // 写盘失败（卷只读/满）→ 90003；DB 已随事务回滚，配置停留上一份一致状态
    if (e instanceof ConfigWriteError) {
      throw fail(CODE.LLM_NOT_CONFIGURED, '配置写盘失败，已回滚数据库变更')
    }
    throw e
  }
}
