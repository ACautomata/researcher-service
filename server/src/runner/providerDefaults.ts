// minimax 默认 provider 常量 + 惰性物化（#775 · 731 §6 迁移映射末行）。
//
// 语义：「空 providers → 模板默认」的显式 seed 化——存量用户经迁移脚本落行
//（scripts/lib/incremental-schema.mjs v9 段，内联同值 JSON）；迁移后新建用户（bootstrap/
// admin 建号）在 ProviderRegistry 首次取快照时惰性物化同一行（INSERT OR IGNORE 语义幂等，
// 用户建号面零耦合）。两处同源由 providerDefaults.test.ts 漂移守卫锁定：
//   本文件常量（单一来源；deploy/openclaw.json 模板真值面已随 T0 #801 退役）↔ 增量脚本内联 JSON。

import type { PrismaClient } from '../generated/prisma/client'

// minimax 默认模型清单（勿手改——增量脚本内联同值 JSON，漂移守卫测试会红）。
export const DEFAULT_MINIMAX_MODELS_JSON =
  '[{"id":"MiniMax-M3","name":"MiniMax M3","reasoning":true,"input":["text","image"],"cost":{"input":0.3,"output":1.2,"cacheRead":0.06,"cacheWrite":0.375},"contextWindow":1048576,"maxTokens":524288}]'

export const DEFAULT_MINIMAX = {
  providerId: 'minimax',
  lcProvider: 'anthropic' as const, // 模板 api: anthropic-messages → lcProvider 1:1（values.ts 映射）
  baseUrl: 'https://api.minimaxi.com/anthropic',
  credentialEnvId: 'LLM_API_KEY',
  authHeader: true,
  modelsJson: DEFAULT_MINIMAX_MODELS_JSON,
} as const

// 迁移脚本同构的确定性 seed 行 id（重跑 INSERT OR IGNORE 命中同主键）。
export function defaultProviderRowId(ownerId: string): string {
  return `seed-mp-minimax-${ownerId}`
}

// 惰性物化：owner 当前零 provider 行时补默认行。幂等 = 主键确定性 + unique(ownerId, providerId)
// 双保险——并发首跑/已有行 → P2002 吞掉（调用方 loadSnapshot 已查空，此处只兜竞态窗口）。
export async function materializeDefaultProvider(
  prisma: Pick<PrismaClient, 'modelProvider'>,
  ownerId: string,
): Promise<void> {
  try {
    await prisma.modelProvider.create({
      data: {
        id: defaultProviderRowId(ownerId),
        ownerId,
        providerId: DEFAULT_MINIMAX.providerId,
        lcProvider: DEFAULT_MINIMAX.lcProvider,
        baseUrl: DEFAULT_MINIMAX.baseUrl,
        credentialEnvId: DEFAULT_MINIMAX.credentialEnvId,
        authHeader: DEFAULT_MINIMAX.authHeader,
        modelsJson: DEFAULT_MINIMAX.modelsJson,
      },
    })
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return // 已有行/并发物化——幂等
    throw e
  }
}
