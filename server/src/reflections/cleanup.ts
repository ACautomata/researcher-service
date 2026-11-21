// #1084（RF-T08）来源失效清理：可靠 outbox 重放（父规格 I4/I9）。
//
// 触发器和 SessionService 删除事务只负责「先封锁」并把来源摘录写进 outbox；本服务负责
// 「后清理」——把正文/原因/适用范围/展示副本/旧 revision 中逐字复制的来源片段替换为占位，
// 并清空失效证据摘录。幂等、可重放、启动即扫；断点只影响副本清理进度，不解除读门封锁。
//
// 清理器是服务级基础设施，不建 Agent、不调用 LLM、不依赖 SSE。

import { purgeDraftCopies } from './retention'
import type { PrismaClient } from '../generated/prisma/client'
import { scrubBodyJson, scrubEvidenceJson } from './content'
import {
  REFLECTION_CLEANUP_BATCH_SIZE,
  REFLECTION_CLEANUP_INTERVAL_MS,
  REFLECTION_INVALID_EXCERPT_PLACEHOLDER,
  REFLECTION_SOURCE_INVALID_REASONS,
} from './values'

export interface ReflectionCleanupOptions {
  /** 启动即扫 + 周期扫描间隔（缺省 60s；父规格：TTL/清理每分钟）。 */
  clock?: () => number
  intervalMs?: number
  batchSize?: number
  onError?: (err: unknown) => void
}

const DEFAULT_INTERVAL_MS = REFLECTION_CLEANUP_INTERVAL_MS
const DEFAULT_BATCH_SIZE = REFLECTION_CLEANUP_BATCH_SIZE

interface OutboxRow {
  id: string
  ownerId: string
  sessionId: string
  messageId: string | null
  kind: string
  excerpt: string
}

export class ReflectionCleanupService {
  private timer: NodeJS.Timeout | undefined
  private inFlight: Promise<number> | null = null
  private stopped = false

  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: ReflectionCleanupOptions = {},
  ) {}

  /** 启动：立即重放一次 + 周期扫描（重启不遗漏）。 */
  start(): void {
    if (this.timer !== undefined) return
    this.stopped = false
    void this.drain()
    this.timer = setInterval(() => void this.drain(), this.options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** 干净关闭：停止接收新批次并等待当前短事务结束（父规格 I9）。 */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    await this.inFlight?.catch(() => {})
  }

  /**
   * 处理至多 limit 条 pending outbox（按入队顺序）。返回实际处理条数。
   * 并发调用复用同一在飞批次，避免两个清理循环互抢同一行。
   */
  processPending(limit?: number): Promise<number> {
    if (this.inFlight !== null) return this.inFlight
    const batch = limit ?? this.options.batchSize ?? DEFAULT_BATCH_SIZE
    this.inFlight = this.processBatch(batch).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async drain(): Promise<void> {
    const batchSize = this.options.batchSize ?? DEFAULT_BATCH_SIZE
    while (!this.stopped) {
      try {
        const processed = await this.processPending(batchSize)
        if (processed < batchSize) return
      } catch (err) {
        // 清理失败不解除读门封锁；告警后由下次周期/重启重放（父规格 I9：不得静默）。
        if (this.options.onError) this.options.onError(err)
        else console.warn(`[reflections] cleanup batch failed: ${(err as Error).message}`)
        return
      }
    }
  }

  private async processBatch(limit: number): Promise<number> {
    await this.pruneExpired()
    const rows = await this.prisma.reflectionCleanupOutbox.findMany({
      where: { state: 'pending' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    })
    if (rows.length === 0) return 0
    // 同一来源消息的多条摘录合并为一次清理（减少重复扫描；仍按行标记 done）。
    const groups = new Map<string, OutboxRow[]>()
    for (const row of rows as OutboxRow[]) {
      const key = `${row.ownerId}\u0000${row.sessionId}\u0000${row.messageId ?? ''}`
      const list = groups.get(key)
      if (list) list.push(row)
      else groups.set(key, [row])
    }
    let processed = 0
    for (const group of groups.values()) {
      try {
        await this.cleanupGroup(group)
        processed += group.length
      } catch (err) {
        this.options.onError?.(err)
        await this.prisma.reflectionCleanupOutbox.updateMany({
          where: { id: { in: group.map((row) => row.id) }, state: 'pending' },
          data: { attempts: { increment: 1 } },
        }).catch(() => {})
      }
    }
    return processed
  }

  private async pruneExpired(): Promise<void> {
    const now = new Date(this.options.clock?.() ?? Date.now())
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86400000)
    await this.prisma.$transaction(async tx => {
      const expired = await tx.reflectionDraft.findMany({ where: { status: { in: ['preparing', 'pending', 'confirmed_pending_save'] }, createdAt: { lte: daysAgo(30) } } })
      for (const draft of expired) await purgeDraftCopies(tx, draft.ownerId, [draft.id], now, 'expired')
      const grants = await tx.reflectionGrant.findMany({ where: { status: 'active', expiresAt: { lte: now } } })
      for (const grant of grants) {
        await tx.reflectionGrant.update({ where: { id: grant.id }, data: { status: 'expired' } })
        await tx.reflectionPresentation.updateMany({ where: { displayId: grant.displayId, status: { in: ['active', 'acked'] } }, data: { status: 'expired', revokedAt: now } })
        await tx.reflectionDraft.updateMany({ where: { id: grant.draftId, status: 'confirmed_pending_save' }, data: { status: 'pending' } })
      }
      // 旧版本关系回填：清理幂等结果前保存专属草稿归属，后续删除仍能找到最初 create。
      const results = await tx.reflectionIdempotency.findMany({ where: { createdAt: { lte: daysAgo(30) } } })
      for (const result of results) {
        const confirmationMessageId = result.key.slice(result.ownerId.length + 1)
        const grant = await tx.reflectionGrant.findUnique({ where: { ownerId_confirmationMessageId: { ownerId: result.ownerId, confirmationMessageId } } })
        if (grant) await tx.reflectionDraft.updateMany({ where: { id: grant.draftId, committedRecordId: null }, data: { committedRecordId: result.recordId } })
      }
      await tx.reflectionIdempotency.deleteMany({ where: { createdAt: { lte: daysAgo(30) } } })
      await tx.reflectionEvent.deleteMany({ where: { createdAt: { lte: daysAgo(90) } } })
    })
  }

  private async cleanupGroup(rows: readonly OutboxRow[]): Promise<void> {
    const first = rows[0]!
    const excerpts = [...new Set(rows.map((row) => row.excerpt).filter((text) => text.length > 0))]
    if (excerpts.length === 0) {
      await this.markDone(rows.map((row) => row.id))
      return
    }
    await this.prisma.$transaction(async (tx) => {
      const sourceWhere = first.messageId === null
        ? { ownerId: first.ownerId, sessionId: first.sessionId, messageId: null }
        : { ownerId: first.ownerId, sessionId: first.sessionId, messageId: first.messageId }

      const draftEvidence = await tx.reflectionEvidence.findMany({
        where: sourceWhere,
        select: { draftId: true },
      })
      const draftIds = [...new Set(draftEvidence.map((e) => e.draftId))]

      const recordEvidence = await tx.reflectionRecordEvidence.findMany({
        where: sourceWhere,
        select: { recordId: true },
      })
      const recordIds = [...new Set(recordEvidence.map((e) => e.recordId))]

      // 草稿正文副本。
      for (const draftId of draftIds) {
        const draft = await tx.reflectionDraft.findUnique({ where: { id: draftId } })
        if (!draft || draft.contentJson === '{}') continue
        const cleaned = scrubBodyJson(draft.contentJson, excerpts)
        if (cleaned !== draft.contentJson) {
          await tx.reflectionDraft.update({ where: { id: draftId }, data: { contentJson: cleaned } })
        }
      }

      // 展示副本（正文 + 证据摘录）。
      for (const draftId of draftIds) {
        const presentations = await tx.reflectionPresentation.findMany({
          where: { draftId },
          select: { displayId: true, bodyJson: true },
        })
        for (const presentation of presentations) {
          if (presentation.bodyJson === '{}') continue
          const cleaned = scrubBodyJson(presentation.bodyJson, excerpts)
          if (cleaned !== presentation.bodyJson) {
            await tx.reflectionPresentation.update({
              where: { displayId: presentation.displayId },
              data: { bodyJson: cleaned },
            })
          }
        }
      }

      // 已提交记录正文 + 全部不可变 revision 快照。
      for (const recordId of recordIds) {
        const record = await tx.reflectionRecord.findUnique({ where: { id: recordId } })
        if (record) {
          const cleaned = scrubBodyJson(record.contentJson, excerpts)
          if (cleaned !== record.contentJson) {
            await tx.reflectionRecord.update({ where: { id: recordId }, data: { contentJson: cleaned } })
          }
        }
        const revisions = await tx.reflectionRevision.findMany({ where: { recordId } })
        for (const revision of revisions) {
          const cleanedBody = scrubBodyJson(revision.bodyJson, excerpts)
          const cleanedEvidence = scrubEvidenceJson(revision.evidenceJson, excerpts)
          if (cleanedBody !== revision.bodyJson || cleanedEvidence !== revision.evidenceJson) {
            await tx.reflectionRevision.update({
              where: { recordId_version: { recordId, version: revision.version } },
              data: { bodyJson: cleanedBody, evidenceJson: cleanedEvidence },
            })
          }
        }
      }

      // 失效证据摘录本身（正文片段先清、摘录后清——重试时仍可从 outbox 取原文）。
      await tx.reflectionEvidence.updateMany({
        where: {
          ...sourceWhere,
          status: { not: 'valid' },
          reason: { in: [...REFLECTION_SOURCE_INVALID_REASONS] },
        },
        data: { excerpt: REFLECTION_INVALID_EXCERPT_PLACEHOLDER },
      })
      await tx.reflectionRecordEvidence.updateMany({
        where: { ...sourceWhere, status: 'invalid' },
        data: { excerpt: REFLECTION_INVALID_EXCERPT_PLACEHOLDER },
      })

      await tx.reflectionCleanupOutbox.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, state: 'pending' },
        // 完成后不再保留来源摘录副本（outbox 只在待清理期间持有原文）。
        data: { state: 'done', excerpt: '', attempts: { increment: 1 } },
      })
    })
  }

  private async markDone(ids: readonly string[]): Promise<void> {
    await this.prisma.reflectionCleanupOutbox.updateMany({
      where: { id: { in: [...ids] }, state: 'pending' },
      data: { state: 'done', excerpt: '', attempts: { increment: 1 } },
    })
  }
}
