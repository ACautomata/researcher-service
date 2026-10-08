// ModelProviderService —— 每用户 LLM 端点（BYOK）CRUD + 热生效版本号（#336；#771 归属上移；
// #881 预设制换形 + 凭证单向流）。
//
// 事务语义（#775 先例保留）：DB mutation + config_meta version bump 同一事务；配置变更经
// version 信号热生效（下一个 run 重建快照），在飞 run 持旧快照跑完。unique(ownerId, providerId)
// 并发冲突 → P2002 → 40041；目标行缺失 → P2025 → 40040。
//
// 预设制（#881）：preset_id ∈ 端点预设清单（presets.ts 单一来源）——协议/baseUrl/凭证头策略
// 随预设派生，行内无自由地址（SSRF 构造性消灭；白名单双层校验链随票退役）。provider_id 保留域
// 'platform' 写侧拒绝（防与平台虚拟条目歧义；zod 已挡，本层防御重复）。
//
// 凭证单向流：写请求可带明文 api_key，落库即 AES-256-GCM 密文（cipher.ts，密钥
// LLM_CREDENTIAL_SECRET）；任何读路径只出掩码，响应体永无明文无密文。POST 空/缺省 = 用平台
// 共享 key（cipher NULL）；PUT 空/缺省 = 保持既有凭证不变。解密失败读不炸（key_error 标记，
// 掩码置 null）——错钥（轮换缺失）只降级展示与运行时（运行时报 LLM 未配置），管理面可用。
//
// #857（退役②）：ownerId 由路由层从认证身份直派生传入。provider 级「不存在 vs 越权」同码
// 40040（#336 验收）：非 owner 到不了目标行，对外逐字节一致。

import type { ModelProvider, PrismaClient } from '../generated/prisma/client'
import { fail } from '../envelope'
import { CODE } from '../codes'
import { config } from '../config'
import { bumpConfigVersion } from './configVersion'
import { decryptCredential, encryptCredential, isCredentialEnvelope } from './cipher'
import { ENDPOINT_PRESETS, RESERVED_PROVIDER_IDS, presetById } from './presets'

// 写侧输入（路由层已把 snake_case body 经 zod 校验后映射为 camelCase domain shape）
export interface ModelProviderWriteInput {
  providerId: string
  presetId: string
  /** 明文 key：undefined/'' 语义按操作区分（create=平台共享 key；update=保持不变） */
  apiKey?: string
  models: Array<Record<string, unknown>>
}

// 读侧输出（snake_case wire）：任何字段永不含 key 明文/密文。
// protocol/base_url 为 string（非 EndpointProtocol 窄型）：预设清单随版收缩后的存量行
// 无预设可派生——管理面如实出空串（只读展示，无 origin 接触；运行时 fail-closed 跳过见
// providerRegistry.rowToEntry），不回退任何预设形状。
export interface ModelProviderView {
  id: string
  provider_id: string
  preset_id: string
  protocol: string
  base_url: string
  /** 掩码（如 'sk-••••abcd'）；null = 未设自己的 key（走平台共享）或解密失败 */
  api_key_masked: string | null
  /** cipher 存在但解密失败（错钥）——读不炸标记；true 时运行时报 LLM 未配置 */
  key_error: boolean
  models: Array<Record<string, unknown>>
  created_at: Date
}

function decodeModels(raw: string): Array<Record<string, unknown>> {
  try {
    const v: unknown = JSON.parse(raw)
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>
  } catch {
    // 坏 JSON → 回退 []
  }
  return []
}

// 掩码：保留前 3 + 末 4，其余以 •••• 收敛；隐藏位 < 4（≤10 位短串）全掩码——
// 短串露 7 位只剩个位数未知，掩码形同虚设。绝不回明文。
export function maskApiKey(plaintext: string): string {
  if (plaintext.length - 7 < 4) return '••••'
  return `${plaintext.slice(0, 3)}••••${plaintext.slice(-4)}`
}

function toView(row: ModelProvider, credentialSecret: string): ModelProviderView {
  const preset = presetById(row.presetId)
  // 未知预设（清单随版收缩）→ 如实出空串（不回退任何预设形状；运行时该行走 fail-closed
  // 跳过，管理面保留可见可删）
  const protocol: string = preset?.protocol ?? ''
  const baseUrl = preset?.baseUrl ?? ''
  let masked: string | null = null
  let keyError = false
  if (row.credentialCipher !== null) {
    if (!isCredentialEnvelope(row.credentialCipher)) {
      keyError = true
    } else {
      try {
        masked = maskApiKey(decryptCredential(row.credentialCipher, credentialSecret))
      } catch {
        keyError = true // 错钥/篡改：读不炸，标 key_error（掩码置 null）
      }
    }
  }
  return {
    id: row.id,
    provider_id: row.providerId,
    preset_id: row.presetId,
    protocol,
    base_url: baseUrl,
    api_key_masked: masked,
    key_error: keyError,
    models: decodeModels(row.modelsJson),
    created_at: row.createdAt,
  }
}

export class ModelProviderService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly credentialSecret: string = config.llm.credentialSecret,
  ) {}

  async list(ownerId: string): Promise<ModelProviderView[]> {
    const rows = await this.prisma.modelProvider.findMany({
      where: { ownerId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return rows.map((r) => toView(r, this.credentialSecret))
  }

  async get(ownerId: string, pid: string): Promise<ModelProviderView> {
    return toView(await this.requireProvider(ownerId, pid), this.credentialSecret)
  }

  async create(ownerId: string, input: ModelProviderWriteInput): Promise<ModelProviderView> {
    this.assertReserved(input.providerId)
    this.assertPreset(input.presetId)
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.modelProvider.create({
          data: {
            ownerId,
            providerId: input.providerId,
            presetId: input.presetId,
            credentialCipher: this.cipherOrNull(input.apiKey),
            modelsJson: JSON.stringify(input.models),
          },
        })
        await bumpConfigVersion(tx)
        return created
      })
      return toView(row, this.credentialSecret)
    } catch (e) {
      this.rethrowKnown(e)
    }
  }

  async update(ownerId: string, pid: string, input: ModelProviderWriteInput): Promise<ModelProviderView> {
    this.assertReserved(input.providerId)
    this.assertPreset(input.presetId)
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        // 复合唯一 where 定位目标行（路径 pid）：不存在 → P2025 → 40040。
        // key 留空（undefined/''）= 保持既有凭证不变——先读后写（事务内行级一致）。
        const existing = await tx.modelProvider.findUnique({
          where: { ownerId_providerId: { ownerId, providerId: pid } },
        })
        if (!existing) {
          // eslint-disable-next-line no-console
          console.warn(`[models] provider_not_found: ownerId=${ownerId} pid=${pid}`)
          throw fail(CODE.PROVIDER_NOT_FOUND)
        }
        const nextCipher =
          input.apiKey !== undefined && input.apiKey !== ''
            ? this.cipherOrNull(input.apiKey)
            : existing.credentialCipher
        return tx.modelProvider.update({
          where: { ownerId_providerId: { ownerId, providerId: pid } },
          data: {
            providerId: input.providerId,
            presetId: input.presetId,
            credentialCipher: nextCipher,
            modelsJson: JSON.stringify(input.models),
          },
        }).then(async (updated) => {
          await bumpConfigVersion(tx)
          return updated
        })
      })
      return toView(row, this.credentialSecret)
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

  // 明文 key → 密文；空/缺省 → NULL（平台共享 key）。
  private cipherOrNull(apiKey: string | undefined): string | null {
    if (apiKey === undefined || apiKey === '') return null
    return encryptCredential(apiKey, this.credentialSecret)
  }

  // provider_id 保留域防御（zod 主闸；防绕过路由直接调 service）。
  private assertReserved(providerId: string): void {
    if (RESERVED_PROVIDER_IDS.has(providerId)) {
      throw fail(CODE.VALIDATION_FAILED, undefined, { provider_id: ['provider_id 为保留 id，不可使用'] })
    }
  }

  private assertPreset(presetId: string): void {
    if (!presetById(presetId)) {
      throw fail(CODE.VALIDATION_FAILED, undefined, {
        preset_id: [`preset_id 须为端点预设之一（${ENDPOINT_PRESETS.map((p) => p.id).join(' | ')}）`],
      })
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
