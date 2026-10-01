// 热生效版本号 bump（#775 · 731 §4）：models 配置域全部写操作（model provider CRUD +
// provider_endpoints CRUD）共享——事务内 config_meta.version +1 = runner 侧 run 启动读版本
// 判等的失效信号。行缺失（未跑迁移的存量库）→ 补种子行（version=2：本事务已变更配置）。

import type { PrismaClient } from '../generated/prisma/client'

export async function bumpConfigVersion(tx: Pick<PrismaClient, 'configMeta'>): Promise<void> {
  try {
    await tx.configMeta.update({
      where: { id: 1 },
      data: { version: { increment: 1 } },
    })
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2025') throw e
    await tx.configMeta.create({ data: { id: 1, version: 2 } })
  }
}
