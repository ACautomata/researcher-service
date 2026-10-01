// minimax 默认 provider 显式 seed（731 §6 / #775）：对齐 ProviderConfigBuilder「空 providers →
// 模板默认 minimax」的 P0 兼容语义——写盘链退役后 DB 是唯一真值源，无 provider 行的用户不再有
// 隐式模板兜底，改为显式 seed：每存量用户一行 minimax（归属按 ownerId 折叠去重，幂等可重跑）。
//
// 幂等：仅当该 owner 零 provider 行时插入；INSERT 撞 unique(ownerId, providerId)（并发 seed）
// 捕 P2002 跳过。已有显式配置的用户不动（不追加、不改写）。
//
// 端点白名单条目（https://api.minimaxi.com）由 incremental-schema 的 'seed-minimax-endpoint'
// 种子负责（#771 已落），本模块只种 provider 行。旧形状（containerId）model_providers 表留待
// T0 清退（#801），本模块不触达。
//
// 调用面三处：
//   1. scripts/seed-minimax.ts（tsx CLI，npm run seed:minimax）——存量用户一次性迁移；
//   2. auth/userService.createUser——新建账号种子（对齐「空 providers → 模板默认」现行为，
//      使升级对用户无感延伸到新用户）；
//   3. 测试直调。

import type { PrismaClient } from '../generated/prisma/client'
import { WIRE_TO_LC_PROVIDER } from './values'

// deploy/openclaw.json 模板 minimax provider 块的显式 DB 平移（逐字段对齐 731 §6 映射表：
// map key → providerId；baseUrl 原样；SecretRef → credentialEnvId；api 'anthropic-messages' →
// lcProvider 'anthropic'；models[] 原样保留——cost 字段为面板展示/核算输入，运行时能力面由
// LangChain model profile 承担）。
export const MINIMAX_SEED_PROVIDER_ID = 'minimax'
export const MINIMAX_SEED_BASE_URL = 'https://api.minimaxi.com/anthropic'
export const MINIMAX_SEED_MODELS: ReadonlyArray<Record<string, unknown>> = [
  {
    id: 'MiniMax-M3',
    name: 'MiniMax M3',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
    contextWindow: 1048576,
    maxTokens: 524288,
  },
]

export interface SeedMinimaxReport {
  // 本次真正插入 minimax 行的 owner（首次跑 = 全部无配置用户；重跑 = 空数组，幂等凭据）
  seededOwnerIds: string[]
  // 已有显式 provider 配置、跳过 seed 的 owner 数
  skippedOwners: number
  // (ownerId, providerId) 重复行折叠删除数（防御性去重——unique 约束下正常库恒 0）
  foldedRows: number
}

// (ownerId, providerId) 折叠去重纯函数：同键保留 createdAt 最早一行（id 升序 tie-break 保
// 确定性），其余为待删冗余。731 §6「冲突取 createdAt 最早行」。
export function foldExtrasByOwnerProvider<
  T extends { ownerId: string; providerId: string; createdAt: Date; id: string },
>(rows: ReadonlyArray<T>): T[] {
  const keep = new Map<string, T>()
  for (const row of rows) {
    const key = `${row.ownerId}|${row.providerId}`
    const incumbent = keep.get(key)
    if (!incumbent) {
      keep.set(key, row)
      continue
    }
    const earlier =
      row.createdAt.getTime() < incumbent.createdAt.getTime() ||
      (row.createdAt.getTime() === incumbent.createdAt.getTime() && row.id < incumbent.id)
    if (earlier) keep.set(key, row)
  }
  const kept = new Set(keep.values())
  return rows.filter((row) => !kept.has(row))
}

// 单 owner seed（createUser 钩子消费的原子面）：owner 零 provider 行 → 插 minimax 种子行。
// 返回是否真正插入。
export async function seedMinimaxForOwner(
  prisma: Pick<PrismaClient, 'modelProvider'>,
  ownerId: string,
): Promise<boolean> {
  const existing = await prisma.modelProvider.findFirst({ where: { ownerId }, select: { id: true } })
  if (existing) return false
  try {
    await prisma.modelProvider.create({
      data: {
        ownerId,
        providerId: MINIMAX_SEED_PROVIDER_ID,
        lcProvider: WIRE_TO_LC_PROVIDER['anthropic-messages'],
        baseUrl: MINIMAX_SEED_BASE_URL,
        credentialEnvId: 'LLM_API_KEY',
        authHeader: true,
        modelsJson: JSON.stringify(MINIMAX_SEED_MODELS),
      },
    })
    return true
  } catch (e) {
    // 并发 seed / 种子行已存在（重跑）→ 幂等跳过；其余错误上抛
    if ((e as { code?: string }).code === 'P2002') return false
    throw e
  }
}

// 存量用户全量 seed（一次性迁移，幂等可重跑）：折叠 (ownerId, providerId) 冗余行 → 逐 owner
// 零配置者插 minimax。重跑不产生重复行（验收：seed 迁移脚本幂等）。
export async function seedMinimaxDefaultProviders(
  prisma: Pick<PrismaClient, 'user' | 'modelProvider'>,
): Promise<SeedMinimaxReport> {
  const report: SeedMinimaxReport = { seededOwnerIds: [], skippedOwners: 0, foldedRows: 0 }

  // 折叠：先清 (ownerId, providerId) 冗余行（防御；正常库恒 0），再判定零配置 owner。
  // 折叠保 (ownerId, providerId) 键的最早行——有任一行的 owner 折叠后仍有行，故
  // ownersWithProviders（按折叠前行集计算）即折叠后的「已有显式配置」真值集。
  const allRows = await prisma.modelProvider.findMany({
    select: { id: true, ownerId: true, providerId: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const extras = foldExtrasByOwnerProvider(allRows)
  for (const extra of extras) {
    await prisma.modelProvider.delete({ where: { id: extra.id } })
    report.foldedRows += 1
  }
  const ownersWithProviders = new Set(allRows.map((r) => r.ownerId))

  const users = await prisma.user.findMany({ select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  for (const user of users) {
    if (ownersWithProviders.has(user.id)) {
      report.skippedOwners += 1
      continue
    }
    if (await seedMinimaxForOwner(prisma, user.id)) report.seededOwnerIds.push(user.id)
  }
  return report
}
