// 插件 LLM 指派服务（#883 T3 · #880 Implementation Decisions「插件 LLM 指派」节）：
// per-user per-plugin 端点/模型指派 CRUD，落 plugin_llm_assignments（#881 T1 建表备用，
// 复合主键 ownerId+pluginId；pluginId 含保留键 'judge'——审批判定器指派行，执行面归后票）。
//
// 可指派域 = 声明 llm 的目录插件 ∪ {'judge'}：未声明插件/目录外 id 一律 80040 同码防探测
//（对齐 plugins 路由既有锁式）。写侧校验（#883 AC）：端点 ∈ 用户端点集 ∪ 'platform'
//（90002 字段级）；model_id 须属该端点模型集（平台侧取值域 = platformModelIds env 派生）；
// provider_id null = 显式「跟随默认链」。mutation 与 config_meta version bump 同事务
//（复用 models/configVersion——热生效信号，下一 run 重建快照，在飞 run 不受影响）。
//
// 读侧无凭证面：行里只有 id 引用（providerId/modelId），永无 key 材料。

import type { PrismaClient } from '../generated/prisma/client'
import { fail } from '../envelope'
import { CODE } from '../codes'
import { config } from '../config'
import { bumpConfigVersion } from '../models/configVersion'
import { modelIdsFromJson } from '../models/modelsJson'
import { PLATFORM_PROVIDER_ID, platformModelIds } from '../models/presets'
import { PROVIDER_ID_REGEX } from '../models/values'
import { JUDGE_PLUGIN_ID } from './registry'
import type { PluginManifest } from './api'

// 可指派 target（指派 UI 一屏的行源；judge 由本服务注入，前端零硬编码）。
export interface AssignmentTarget {
  readonly plugin_id: string
  readonly description: string
  readonly default_model?: string
}

export interface AssignmentView {
  readonly plugin_id: string
  readonly provider_id: string | null
  readonly model_id: string | null
  readonly updated_at: Date
}

export interface AssignmentWriteInput {
  readonly provider_id: string | null
  readonly model_id: string | null
}

export interface PluginAssignmentDeps {
  readonly prisma: PrismaClient
  readonly manifests: readonly PluginManifest[]
}

// judge 行的 target 描述（目录外保留键的固定标签；前端零硬编码）。
const JUDGE_TARGET_DESCRIPTION = '审批判定器（审批灰区调用的 LLM 模型）'

export class PluginLlmAssignmentService {
  constructor(private readonly deps: PluginAssignmentDeps) {}

  // 可指派性（80040 判定准据）：声明 llm 的目录插件 ∪ 保留键 'judge'。
  private isAssignable(pluginId: string): boolean {
    if (pluginId === JUDGE_PLUGIN_ID) return true
    return this.deps.manifests.some((m) => m.id === pluginId && m.llm !== undefined)
  }

  async list(ownerId: string): Promise<{ targets: AssignmentTarget[]; assignments: AssignmentView[] }> {
    const targets: AssignmentTarget[] = this.deps.manifests
      .filter((m) => m.llm !== undefined)
      .map((m) => ({
        plugin_id: m.id,
        description: m.llm!.description,
        ...(m.llm!.defaultModel !== undefined ? { default_model: m.llm!.defaultModel } : {}),
      }))
    targets.push({ plugin_id: JUDGE_PLUGIN_ID, description: JUDGE_TARGET_DESCRIPTION })
    const rows = await this.deps.prisma.pluginLlmAssignment.findMany({
      where: { ownerId },
      orderBy: [{ pluginId: 'asc' }],
    })
    return {
      targets,
      assignments: rows.map((r) => ({
        plugin_id: r.pluginId,
        provider_id: r.providerId,
        model_id: r.modelId,
        updated_at: r.updatedAt,
      })),
    }
  }

  async upsert(ownerId: string, pluginId: string, input: AssignmentWriteInput): Promise<AssignmentView> {
    if (!this.isAssignable(pluginId)) throw fail(CODE.PLUGIN_NOT_FOUND)
    const fieldErrors = await this.validateRefs(ownerId, input)
    if (fieldErrors) throw fail(CODE.VALIDATION_FAILED, undefined, fieldErrors)
    const row = await this.deps.prisma.$transaction(async (tx) => {
      const upserted = await tx.pluginLlmAssignment.upsert({
        where: { ownerId_pluginId: { ownerId, pluginId } },
        create: { ownerId, pluginId, providerId: input.provider_id, modelId: input.model_id },
        update: { providerId: input.provider_id, modelId: input.model_id },
      })
      await bumpConfigVersion(tx)
      return upserted
    })
    return this.toView(pluginId, row.providerId, row.modelId, row.updatedAt)
  }

  // 撤指派 = 删行回默认链（bump）；无行幂等（不 bump——无配置变更事实）。
  async remove(ownerId: string, pluginId: string): Promise<void> {
    if (!this.isAssignable(pluginId)) throw fail(CODE.PLUGIN_NOT_FOUND)
    await this.deps.prisma.$transaction(async (tx) => {
      const deleted = await tx.pluginLlmAssignment.deleteMany({ where: { ownerId, pluginId } })
      if (deleted.count > 0) await bumpConfigVersion(tx)
    })
  }

  // 引用校验（90002 字段级，#883 AC「指派校验」）：
  //   - provider_id null ⇒ model_id 须 null（无端点无处挂模型）
  //   - 'platform' ⇒ model ∈ platformModelIds（env 派生）
  //   - 其余 ⇒ PROVIDER_ID_REGEX 形态 + 本人端点行存在；model ∈ 该行 modelsJson id 集
  // 返回 null = 全过；返回字段错误表 = 90002。
  private async validateRefs(ownerId: string, input: AssignmentWriteInput): Promise<Record<string, string[]> | null> {
    const errors: Record<string, string[]> = {}
    const settle = (): Record<string, string[]> | null => (Object.keys(errors).length > 0 ? errors : null)
    if (input.provider_id === null) {
      if (input.model_id !== null) errors.model_id = ['model_id 须为 null（provider_id 为空 = 跟随默认链，无端点可挂模型）']
      return settle()
    }
    if (input.provider_id === PLATFORM_PROVIDER_ID) {
      const models = platformModelIds(config.llm.model, config.llm.preset)
      if (input.model_id !== null && !models.includes(input.model_id)) {
        errors.model_id = [`model_id 不在平台默认端点模型集内（${models.join(' | ')}）`]
      }
      return settle()
    }
    if (!PROVIDER_ID_REGEX.test(input.provider_id)) {
      errors.provider_id = ['provider_id 须为平台默认端点（platform）或本人端点 id（小写字母开头，1–64 位）']
      return settle()
    }
    const row = await this.deps.prisma.modelProvider.findUnique({
      where: { ownerId_providerId: { ownerId, providerId: input.provider_id } },
    })
    if (!row) {
      errors.provider_id = ['provider_id 不在本人端点集中']
      return settle()
    }
    if (input.model_id !== null) {
      const models = modelIdsFromJson(row.modelsJson)
      if (!models.includes(input.model_id)) {
        errors.model_id = [`model_id 不在端点 ${input.provider_id} 的模型集内`]
      }
    }
    return settle()
  }

  private toView(pluginId: string, providerId: string | null, modelId: string | null, updatedAt: Date): AssignmentView {
    return { plugin_id: pluginId, provider_id: providerId, model_id: modelId, updated_at: updatedAt }
  }
}
