// 反思专属副本清理（#1085）：短写事务，与授权/目标 CAS 同一提交边界。
import { purgeReflectionToolInputs } from './checkpointCopies'
import type { PrismaClient } from '../generated/prisma/client'
type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]

export async function purgeDraftCopies(tx: Tx, ownerId: string, ids: string[], now: Date, status = 'cancelled'): Promise<void> {
  if (!ids.length) return
  await purgeReflectionToolInputs(tx, ownerId, ids)
  await tx.reflectionEvidence.deleteMany({ where: { ownerId, draftId: { in: ids } } })
  await tx.reflectionPresentation.updateMany({ where: { ownerId, draftId: { in: ids } }, data: { status: 'deleted', bodyJson: '{}', revokedAt: now } })
  await tx.reflectionGrant.updateMany({ where: { ownerId, draftId: { in: ids }, status: 'active' }, data: { status: 'revoked' } })
  await tx.reflectionDraft.updateMany({ where: { ownerId, id: { in: ids } }, data: { contentJson: '{}', title: '', category: 'other', targetsJson: '[]', status, closedAt: now } })
}

export async function hardDeleteRecord(tx: Tx, ownerId: string, recordId: string, now: Date): Promise<void> {
  const results = await tx.reflectionIdempotency.findMany({ where: { ownerId, recordId } })
  const confirmations = results.map(r => r.key.slice(ownerId.length + 1))
  const grants = await tx.reflectionGrant.findMany({ where: { ownerId, confirmationMessageId: { in: confirmations } } })
  const drafts = await tx.reflectionDraft.findMany({ where: { ownerId } })
  const ids = new Set(grants.map(g => g.draftId))
  for (const draft of drafts) {
    const targets = JSON.parse(draft.targetsJson ?? '[]') as { record_id: string }[]
    if (draft.committedRecordId === recordId || (targets.some(t => t.record_id === recordId) && draft.status !== 'committed')) ids.add(draft.id)
  }
  const sources = await tx.reflectionRecordEvidence.findMany({ where: { ownerId, recordId }, select: { sessionId: true, messageId: true } })
  sources.push(...await tx.reflectionEvidence.findMany({ where: { ownerId, draftId: { in: [...ids] } }, select: { sessionId: true, messageId: true } }))
  await purgeDraftCopies(tx, ownerId, [...ids], now)
  await tx.reflectionRevision.deleteMany({ where: { recordId } })
  await tx.reflectionRecordEvidence.deleteMany({ where: { recordId, ownerId } })
  await tx.reflectionIdempotency.deleteMany({ where: { ownerId, recordId } })
  // outbox 只在仍有独立草稿/记录需清理时保留原始来源摘录；最后引用随硬删同事务清除。
  const visited = new Set<string>()
  for (const source of sources) {
    const key = JSON.stringify(source)
    if (visited.has(key)) continue
    visited.add(key)
    const where = { ownerId, sessionId: source.sessionId, messageId: source.messageId }
    if (await tx.reflectionEvidence.count({ where }) || await tx.reflectionRecordEvidence.count({ where })) continue
    await tx.reflectionCleanupOutbox.deleteMany({ where })
  }
  // 永久墓碑不复用 ID，generation 递增；正文和可检索元数据物理清空。
  await tx.reflectionRecord.update({ where: { id: recordId }, data: { status: 'deleted', generation: { increment: 1 }, contentJson: '{}', title: '', category: 'other' } })
}
