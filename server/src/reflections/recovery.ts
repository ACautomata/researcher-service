// #1087：离线恢复安全日志。日志只含标识/状态，不含原文；恢复失败保留读写门封锁。
import { createHash, randomUUID } from 'node:crypto'
import { linkSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { z } from 'zod'
import type { PrismaClient } from '../generated/prisma/client'
import { ReflectionCleanupService } from './cleanup'
import { hardDeleteRecord, purgeDraftCopies } from './retention'

const Entry = z.object({ seq: z.number().int().positive(), ownerId: z.string(), kind: z.enum(['record', 'source', 'owner']), objectId: z.string(), state: z.string() }).strict()
const Journal = z.object({ version: z.literal(1), lineage: z.string(), through: z.number().int().nonnegative(), entries: z.array(Entry) }).strict()

/** 停写后的最终安全日志；由运维保存在数据库备份之外，禁止以旧备份自行生成替代。 */
export function exportReflectionSafetyLog(db: Database.Database): unknown {
  return db.transaction(() => {
    const state = db.prepare('SELECT lineage FROM reflection_recovery_state WHERE id = ?').get('singleton') as { lineage: string }
    const entries = db.prepare('SELECT seq, ownerId, kind, objectId, state FROM reflection_safety_journal ORDER BY seq').all() as z.infer<typeof Entry>[]
    return { version: 1, lineage: state.lineage, through: entries.at(-1)?.seq ?? 0, entries }
  })()
}

/** 最终停写水位的摘要须由备份之外的可信运维记录提供。 */
export function reflectionSafetyDigest(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(Journal.parse(input))).digest('hex')
}

/** 受支持的备份产物携带锁，直接启动也不会开放旧经验。 */
export async function createReflectionBackup(db: Database.Database, destination: string): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.partial`
  try {
    await db.backup(temporary)
    const backup = new Database(temporary)
    try { backup.prepare("UPDATE reflection_recovery_state SET locked = 1 WHERE id = 'singleton'").run() } finally { backup.close() }
    // 仅发布已上锁的完整产物；已有文件不覆盖，崩溃留下的 partial 不可用作恢复输入。
    linkSync(temporary, destination)
  } finally { rmSync(temporary, { force: true }) }
}

/** 必须在任何 HTTP/runner 开放前调用；缺日志/断链/清理失败均保持 locked。 */
export async function replayReflectionSafetyLog(prisma: PrismaClient, input: unknown, trustedDigest: string): Promise<void> {
  await prisma.$executeRawUnsafe("UPDATE reflection_recovery_state SET locked = 1 WHERE id = 'singleton'")
  if (!/^[a-f0-9]{64}$/.test(trustedDigest) || reflectionSafetyDigest(input) !== trustedDigest) throw new Error('reflection safety manifest mismatch')
  const journal = Journal.parse(input)
  const state = await prisma.$queryRawUnsafe<{ lineage: string }[]>("SELECT lineage FROM reflection_recovery_state WHERE id = 'singleton'")
  if (state.length !== 1 || state[0]!.lineage !== journal.lineage || journal.entries.length !== journal.through || journal.entries.some((e, i) => e.seq !== i + 1)) throw new Error('incomplete reflection safety log')
  const old = await prisma.$queryRawUnsafe<z.infer<typeof Entry>[]>('SELECT seq, ownerId, kind, objectId, state FROM reflection_safety_journal ORDER BY seq')
  if (old.some((e, i) => JSON.stringify(e) !== JSON.stringify(journal.entries[i]))) throw new Error('reflection safety log diverged')
  const now = new Date()
  // 旧备份中的未消费授权一律不恢复；重新展示和确认后才可管理。
  await prisma.$transaction(async tx => {
    const drafts = await tx.reflectionDraft.findMany({ where: { status: { not: 'committed' } } })
    for (const draft of drafts) await purgeDraftCopies(tx, draft.ownerId, [draft.id], now)
    await tx.reflectionGrant.updateMany({ where: { status: 'active' }, data: { status: 'revoked' } })
  })
  for (const entry of journal.entries.slice(old.length)) {
    await prisma.$transaction(async tx => {
      if (entry.kind === 'record' || entry.kind === 'owner') {
        const records = await tx.reflectionRecord.findMany({ where: { ownerId: entry.ownerId, ...(entry.kind === 'record' ? { id: entry.objectId } : {}) } })
        for (const record of records) {
          if (entry.kind === 'owner' || entry.state === 'deleted') await hardDeleteRecord(tx, entry.ownerId, record.id, now)
          else if (record.status !== 'deleted') {
            // 日志不含新版本正文，不能证明旧版本仍有效，停止经验增强，保留管理入口复核。
            await tx.reflectionRecord.update({ where: { id: record.id }, data: { status: 'inactive', evidenceStatus: 'review_required', generation: { increment: 1 } } })
          }
        }
      } else {
        const source = { ownerId: entry.ownerId, sessionId: entry.objectId, ...(entry.state ? { messageId: entry.state } : {}) }
        const evidence = await tx.reflectionRecordEvidence.findMany({ where: source })
        for (const e of evidence) {
          await tx.reflectionCleanupOutbox.create({ data: { id: randomUUID(), ownerId: e.ownerId, sessionId: e.sessionId, messageId: e.messageId, kind: 'source_deleted', excerpt: e.excerpt } })
          await tx.reflectionRecord.updateMany({ where: { id: e.recordId, status: { not: 'deleted' } }, data: { evidenceStatus: 'review_required', generation: { increment: 1 } } })
        }
        await tx.reflectionRecordEvidence.updateMany({ where: source, data: { status: 'invalid', reason: 'source_deleted' } })
        await tx.reflectionEvidence.updateMany({ where: source, data: { status: 'not_ready', reason: 'source_deleted' } })
      }
    })
  }
  const cleanup = new ReflectionCleanupService(prisma)
  while (await cleanup.processPending() > 0) { /* 启动前清空所有待处理批次 */ }
  if (await prisma.reflectionCleanupOutbox.count({ where: { state: 'pending' } })) throw new Error('reflection cleanup incomplete')
  for (const entry of journal.entries.slice(old.length)) {
    await prisma.$executeRaw`INSERT INTO reflection_safety_journal(seq,ownerId,kind,objectId,state) VALUES (${entry.seq},${entry.ownerId},${entry.kind},${entry.objectId},${entry.state})`
  }
  await prisma.$executeRawUnsafe("UPDATE reflection_recovery_state SET locked = 0 WHERE id = 'singleton'")
}
