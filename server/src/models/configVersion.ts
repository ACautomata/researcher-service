// 热生效版本号 bump（#775 · 731 §4）：LLM 端点域全部写操作（BYOK 端点 CRUD；#881 预设制
// 后 provider_endpoints 白名单 CRUD 已随票退役）共享——事务内 config_meta.version +1 =
// runner 侧 run 启动读版本判等的失效信号。行缺失（未跑迁移的存量库）→ 补种子行
//（version=2：本事务已变更配置）。

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
