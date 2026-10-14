import type { PrismaClient } from '../generated/prisma/client'

/** Owner capabilities are read at run start, never copied permanently to a child session. */
export async function snapshotRunCapabilities(prisma: PrismaClient, ownerId: string) {
  const rows = await prisma.pluginEnablement.findMany({
    where: { ownerId, enabled: true }, orderBy: { pluginId: 'asc' }, select: { pluginId: true },
  })
  const enabledPluginIds = Object.freeze(rows.map(row => row.pluginId))
  // key 形态 = 单元数组（[#787 官方内容目录退役 #956]：official.version 因子移除——插件
  // 目录版本仍在 plugins.catalogVersion 键位，勿混）。唯一消费面 = runService 图缓存键。
  return Object.freeze({ ownerId, enabledPluginIds, key: JSON.stringify([enabledPluginIds]) })
}
export type RunCapabilities = Awaited<ReturnType<typeof snapshotRunCapabilities>>
