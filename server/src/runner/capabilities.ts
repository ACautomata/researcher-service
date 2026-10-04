import type { PrismaClient } from '../generated/prisma/client'
import { snapshotOfficialContent } from '../officialContent/runtime'

/** Owner capabilities are read at run start, never copied permanently to a child session. */
export async function snapshotRunCapabilities(prisma: PrismaClient, ownerId: string) {
  const official = snapshotOfficialContent()
  const rows = await prisma.pluginEnablement.findMany({
    where: { ownerId, enabled: true }, orderBy: { pluginId: 'asc' }, select: { pluginId: true },
  })
  const enabledPluginIds = Object.freeze(rows.map(row => row.pluginId))
  return Object.freeze({ ownerId, official, enabledPluginIds, key: JSON.stringify([official.version, enabledPluginIds]) })
}
export type RunCapabilities = Awaited<ReturnType<typeof snapshotRunCapabilities>>
