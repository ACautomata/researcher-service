// 反思专属副本清理（#1085）：短写事务，与授权/目标 CAS 同一提交边界。
import type { PrismaClient } from '../generated/prisma/client'
type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]

export async function purgeDraftCopies(tx: Tx, ownerId: string, ids: string[], now: Date, status = 'cancelled'): Promise<void> {
  if (!ids.length) return
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
  await purgeDraftCopies(tx, ownerId, [...ids], now)
  await tx.reflectionRevision.deleteMany({ where: { recordId } })
  await tx.reflectionRecordEvidence.deleteMany({ where: { recordId, ownerId } })
  await tx.reflectionIdempotency.deleteMany({ where: { ownerId, recordId } })
  // 永久墓碑不复用 ID，generation 递增；正文和可检索元数据物理清空。
  await tx.reflectionRecord.update({ where: { id: recordId }, data: { status: 'deleted', generation: { increment: 1 }, contentJson: '{}', title: '', category: 'other' } })
}
