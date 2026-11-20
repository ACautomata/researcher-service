import type { PrismaClient } from '../generated/prisma/client'

/** Owner capabilities are read at run start, never copied permanently to a child session. */
export async function snapshotRunCapabilities(prisma: PrismaClient, ownerId: string) {
  const rows = await prisma.pluginEnablement.findMany({
    where: { ownerId, enabled: true }, orderBy: { pluginId: 'asc' }, select: { pluginId: true },
  })
  const enabledPluginIds = Object.freeze(rows.map(row => row.pluginId))
  // skills 启用位（#1057 C 票，#1054 D4）：per-user × skillId（skill_enablements 独立小表——
  // skill 是市场数据面，不混 plugin_enablements）。同样只读快照，并入 key（图缓存键因子）。
  const skillRows = await prisma.skillEnablement.findMany({
    where: { ownerId, enabled: true }, orderBy: { skillId: 'asc' }, select: { skillId: true },
  })
  const enabledSkillIds = Object.freeze(skillRows.map(row => row.skillId))
  // key 形态 = 单元数组（[#787 官方内容目录退役 #956]：official.version 因子移除——插件
  // 目录版本仍在 plugins.catalogVersion 键位、skill 目录版本在 skills catalog version 键位，
  // 勿混）。唯一消费面 = runService 图缓存键。
  return Object.freeze({ ownerId, enabledPluginIds, enabledSkillIds, key: JSON.stringify([enabledPluginIds, enabledSkillIds]) })
}
export type RunCapabilities = Awaited<ReturnType<typeof snapshotRunCapabilities>>
