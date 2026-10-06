import type { PrismaClient, Session, Teammate, TeammateMailboxMessage } from '../../generated/prisma/client'
import { fail } from '../../envelope'
import { CODE } from '../../codes'
import { createHash } from 'node:crypto'

export const TEAMMATE_MAIL_TTL_MS = 48 * 60 * 60 * 1000
export const DEFAULT_MAIL_WAIT_MS = 30 * 60 * 1000
export const MAX_MAIL_WAIT_MS = 24 * 60 * 60 * 1000

export type TeammateStatus =
  | 'requested'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'archived'

// teammate 类别（#790 · #747 G 节三通道②）：generic = 缺省通用 teammate；wiki-update = 治理
// 生成 teammate（RunService 装配落地副本 backend + openwiki 生命周期工具 + 驱动提示——拓扑
// 可由本持久化列推导，resume/recover 重建同形）。
export type TeammateKind = 'generic' | 'wiki-update'

export interface TeammateSummary {
  readonly id: string
  readonly threadId: string
  readonly name: string
  readonly task: string
  readonly status: TeammateStatus
  readonly kind: TeammateKind
  readonly modelProviderId: string | null
  readonly spawnedAtCheckpointId: string | null
  readonly createdAt: string
}

export interface MailSummary {
  readonly id: string
  readonly senderTeammateId: string | null
  readonly recipientTeammateId: string | null
  readonly kind: string
  readonly content: string
  readonly createdAt: string
  readonly expiresAt: string | null
}

function summary(row: Teammate): TeammateSummary {
  return {
    id: row.id,
    threadId: row.threadId,
    name: row.name,
    task: row.task,
    status: row.status as TeammateStatus,
    kind: (row.kind ?? 'generic') as TeammateKind,
    modelProviderId: row.modelProviderId,
    spawnedAtCheckpointId: row.spawnedAtCheckpointId,
    createdAt: row.createdAt.toISOString(),
  }
}

function mailSummary(row: TeammateMailboxMessage): MailSummary {
  return {
    id: row.id,
    senderTeammateId: row.senderTeammateId,
    recipientTeammateId: row.recipientTeammateId,
    kind: row.kind,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
  }
}

/**
 * Durable teammate and mailbox state for a leader session.
 *
 * Each teammate owns a hidden Session row, which gives LangGraph a distinct
 * thread/checkpoint namespace while preserving the parent sandbox and owner.
 * Mail is immutable and read state is recipient-specific; archived teammates
 * and invalidated messages remain queryable for audit/replay.
 */
export class TeammateService {
  private wakeHandler: ((threadId: string, teammateId: string | null, waitId: string) => Promise<void>) | undefined

  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: () => Date = () => new Date(),
    wake?: (threadId: string, teammateId: string | null, waitId: string) => Promise<void>,
  ) { this.wakeHandler = wake }

  setWakeHandler(wake: ((threadId: string, teammateId: string | null, waitId: string) => Promise<void>) | undefined): void {
    this.wakeHandler = wake
  }

  async spawn(input: {
    parentSessionId: string
    name: string
    task: string
    kind?: TeammateKind
    modelProviderId?: string | null
    spawnedAtCheckpointId?: string | null
  }): Promise<TeammateSummary> {
    const parent = await this.getLeaderSession(input.parentSessionId)
    const trimmedName = input.name.trim()
    const trimmedTask = input.task.trim()
    if (!trimmedName || !trimmedTask) throw new Error('teammate name and task are required')

    const row = await this.prisma.$transaction(async (tx) => {
      const thread = await tx.session.create({
        data: {
          ownerId: parent.ownerId,
          containerId: parent.containerId,
          title: trimmedName,
          preferredModelJson: parent.preferredModelJson,
          isTeammate: true,
        },
      })
      return tx.teammate.create({
        data: {
          parentSessionId: parent.id,
          threadId: thread.id,
          name: trimmedName,
          task: trimmedTask,
          status: 'queued',
          kind: input.kind ?? 'generic',
          modelProviderId: input.modelProviderId ?? null,
          spawnedAtCheckpointId: input.spawnedAtCheckpointId ?? null,
        },
      })
    })
    return summary(row)
  }

  async requestSpawn(input: {
    parentSessionId: string
    requesterTeammateId: string
    name: string
    task: string
  }): Promise<MailSummary> {
    const teammate = await this.getActiveTeammate(input.parentSessionId, input.requesterTeammateId)
    return this.sendMail({
      parentSessionId: input.parentSessionId,
      senderTeammateId: teammate.id,
      recipientTeammateId: null,
      kind: 'request',
      content: JSON.stringify({ name: input.name.trim(), task: input.task.trim() }),
    })
  }

  async list(parentSessionId: string): Promise<TeammateSummary[]> {
    await this.getLeaderSession(parentSessionId)
    const rows = await this.prisma.teammate.findMany({
      where: { parentSessionId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return rows.map(summary)
  }

  async get(parentSessionId: string, teammateId: string): Promise<TeammateSummary> {
    return summary(await this.getActiveTeammate(parentSessionId, teammateId, true))
  }

  async findByName(parentSessionId: string, name: string): Promise<TeammateSummary | undefined> {
    await this.getLeaderSession(parentSessionId)
    const row = await this.prisma.teammate.findFirst({
      where: { parentSessionId, name, archivedAt: null },
    })
    return row ? summary(row) : undefined
  }

  async sendMail(input: {
    parentSessionId: string
    senderTeammateId?: string | null
    recipientTeammateId?: string | null
    kind?: string
    content: string
    ttlMs?: number
  }): Promise<MailSummary> {
    const parent = await this.getLeaderSession(input.parentSessionId)
    if (input.senderTeammateId) {
      await this.getActiveTeammate(input.parentSessionId, input.senderTeammateId)
    }
    if (input.recipientTeammateId) {
      await this.getActiveTeammate(input.parentSessionId, input.recipientTeammateId)
    }
    const now = this.clock()
    const ttlMs = input.ttlMs ?? TEAMMATE_MAIL_TTL_MS
    const row = await this.prisma.$transaction(async tx => {
      const owner = await tx.user.findUniqueOrThrow({ where: { id: parent.ownerId }, select: { username: true } })
      const actors = await tx.teammate.findMany({ where: { parentSessionId: parent.id }, select: { id: true, name: true, archivedAt: true } })
      for (const id of [input.senderTeammateId, input.recipientTeammateId]) {
        if (id && !actors.some(actor => actor.id === id && actor.archivedAt === null)) throw fail(CODE.SESSION_NOT_FOUND)
      }
      const actorName = (id: string | null | undefined) => id ? actors.find(actor => actor.id === id)?.name ?? id : 'leader'
      const mail = await tx.teammateMailboxMessage.create({
        data: {
          parentSessionId: input.parentSessionId,
          senderTeammateId: input.senderTeammateId ?? null,
          recipientTeammateId: input.recipientTeammateId ?? null,
          kind: input.kind ?? 'message',
          content: input.content,
          createdAt: now,
          expiresAt: ttlMs > 0 ? new Date(now.getTime() + ttlMs) : null,
        },
      })
      // Communication audit follows the user's lifetime, independently of session cascades.
      // Commit mail and its audit together before attempting a recipient wake.
      await tx.textTraceLog.create({ data: {
        traceId: `teammate-mail:${mail.id}`, userId: parent.ownerId, username: owner.username,
        ipAddress: 'internal', sessionKey: parent.id, status: 'success', createdAt: now,
        inputText: JSON.stringify({ kind: mail.kind, from: actorName(mail.senderTeammateId), to: actorName(mail.recipientTeammateId), senderTeammateId: mail.senderTeammateId, recipientTeammateId: mail.recipientTeammateId }),
        outputText: mail.content, outputHash: createHash('sha256').update(mail.content).digest('hex'),
      } })
      return mail
    })
    const wait = await this.prisma.teammateMailboxWait.findFirst({
      where: { parentSessionId: input.parentSessionId, recipientTeammateId: input.recipientTeammateId ?? null },
    })
    if (wait) await this.wakeHandler?.(wait.threadId, input.recipientTeammateId ?? null, wait.waitId)
    return mailSummary(row)
  }

  async receiveMail(parentSessionId: string, recipientTeammateId: string | null): Promise<MailSummary[]> {
    await this.getLeaderSession(parentSessionId)
    if (recipientTeammateId) await this.getActiveTeammate(parentSessionId, recipientTeammateId, true)
    const now = this.clock()
    return this.prisma.$transaction(async (tx) => {
      const unread = await tx.teammateMailboxMessage.findMany({
        where: {
          parentSessionId,
          recipientTeammateId,
          readAt: null,
          invalidatedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      if (unread.length === 0) return []
      await tx.teammateMailboxMessage.updateMany({
        where: { id: { in: unread.map((row) => row.id) }, readAt: null, invalidatedAt: null },
        data: { readAt: now },
      })
      return unread.map(mailSummary)
    })
  }

  async registerWait(input: {
    waitId: string
    parentSessionId: string
    threadId: string
    recipientTeammateId: string | null
  }): Promise<void> {
    await this.getLeaderSession(input.parentSessionId)
    await this.prisma.teammateMailboxWait.upsert({
      where: { threadId: input.threadId },
      create: input,
      update: { waitId: input.waitId, recipientTeammateId: input.recipientTeammateId },
    })
  }

  async clearWait(threadId: string, waitId?: string): Promise<void> {
    await this.prisma.teammateMailboxWait.deleteMany({
      where: { threadId, ...(waitId ? { waitId } : {}) },
    })
  }

  async updateStatus(
    parentSessionId: string,
    teammateId: string,
    status: Exclude<TeammateStatus, 'requested'>,
  ): Promise<TeammateSummary> {
    const teammate = await this.getActiveTeammate(parentSessionId, teammateId, true)
    const archivedAt = status === 'archived' ? this.clock() : null
    const updated = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.teammate.updateMany({
        where: { id: teammate.id, ...(status !== 'archived' ? { archivedAt: null } : {}) },
        data: { status, archivedAt },
      })
      const row = await tx.teammate.findUniqueOrThrow({ where: { id: teammate.id } })
      if (updated.count === 0) return row // Archive is terminal; a stale finalizer cannot revive it.
      if (archivedAt) {
        await tx.session.update({ where: { id: row.threadId }, data: { archivedAt } })
      } else {
        await tx.session.update({ where: { id: row.threadId }, data: { archivedAt: null } })
      }
      return row
    })
    return summary(updated)
  }

  archive(parentSessionId: string, teammateId: string): Promise<TeammateSummary> {
    return this.updateStatus(parentSessionId, teammateId, 'archived')
  }

  async mailboxHistory(parentSessionId: string): Promise<MailSummary[]> {
    await this.getLeaderSession(parentSessionId)
    const rows = await this.prisma.teammateMailboxMessage.findMany({
      where: { parentSessionId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return rows.map(mailSummary)
  }

  async invalidateMessages(parentSessionId: string, teammateIds: readonly string[]): Promise<number> {
    await this.getLeaderSession(parentSessionId)
    if (teammateIds.length === 0) return 0
    const result = await this.prisma.teammateMailboxMessage.updateMany({
      where: {
        parentSessionId,
        invalidatedAt: null,
        OR: [
          { senderTeammateId: { in: [...teammateIds] } },
          { recipientTeammateId: { in: [...teammateIds] } },
        ],
      },
      data: { invalidatedAt: this.clock() },
    })
    return result.count
  }

  /**
   * Rewind invalidation: teammates spawned after the target checkpoint no longer belong to
   * the leader's current branch. Their threads are archived and their unread mail is invalidated;
   * history remains available for audit.
   */
  async rewind(parentSessionId: string, targetCheckpointId: string): Promise<string[]> {
    await this.getLeaderSession(parentSessionId)
    const rows = await this.prisma.teammate.findMany({ where: { parentSessionId, archivedAt: null } })
    const invalidated: Teammate[] = []
    for (const teammate of rows) {
      if (!teammate.spawnedAtCheckpointId) continue
      let cursor: string | null = targetCheckpointId
      const seen = new Set<string>()
      let targetDescendsFromSpawn = false
      while (cursor && !seen.has(cursor)) {
        if (cursor === teammate.spawnedAtCheckpointId) {
          targetDescendsFromSpawn = true
          break
        }
        seen.add(cursor)
        const checkpoint: { parentCheckpointId: string | null } | null = await this.prisma.checkpoint.findFirst({
          where: { threadId: parentSessionId, checkpointNs: '', checkpointId: cursor },
          select: { parentCheckpointId: true },
        })
        cursor = checkpoint?.parentCheckpointId ?? null
      }
      if (targetDescendsFromSpawn) continue
      await this.archive(parentSessionId, teammate.id)
      invalidated.push(teammate)
    }
    if (invalidated.length > 0) {
      const ids = invalidated.map((row) => row.id)
      await this.prisma.teammateMailboxMessage.updateMany({
        where: {
          parentSessionId,
          readAt: null,
          invalidatedAt: null,
          OR: [
            { senderTeammateId: { in: ids } },
            { recipientTeammateId: { in: ids } },
          ],
        },
        data: { invalidatedAt: this.clock() },
      })
    }
    return invalidated.map((row) => row.id)
  }

  private async getLeaderSession(sessionId: string): Promise<Pick<Session, 'id' | 'ownerId' | 'containerId' | 'preferredModelJson'>> {
    const row = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, ownerId: true, containerId: true, isTeammate: true, preferredModelJson: true },
    })
    if (!row || row.isTeammate) throw fail(CODE.SESSION_NOT_FOUND)
    return row
  }

  private async getActiveTeammate(
    parentSessionId: string,
    teammateId: string,
    includeArchived = false,
  ): Promise<Teammate> {
    const row = await this.prisma.teammate.findFirst({
      where: {
        id: teammateId,
        parentSessionId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
    })
    if (!row) throw fail(CODE.SESSION_NOT_FOUND)
    return row
  }
}
