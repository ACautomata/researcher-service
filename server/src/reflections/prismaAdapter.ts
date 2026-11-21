// reflections 外层适配（#1080 · RF-T04）：Prisma/SQLite 存储 + 可信当前证据端口。
//
// 内层 service 不依赖 Prisma；本适配负责归属过滤、事务、展示绑定与 ack 单调序号
// （reflection_events AUTOINCREMENT）。草稿正文与正式经验存储分离，草稿绝不进入 experience 检索。

import type { PrismaClient } from '../generated/prisma/client'
import { parseSavedProduct } from '../sessions/productMessage'
import { contentVersionOf, matchExcerpt } from './content'
import type {
  DraftBody,
  DraftRecord,
  EvidenceRecord,
  EvidenceSource,
  ReflectionContext,
  ReflectionEvidencePort,
  ReflectionStore,
} from './model'
import type { ReflectionDraftStatus, ReflectionPresentationStatus, ReflectionRegion } from './values'

const EMPTY_BODY: DraftBody = {
  title: '',
  category: 'other',
  problem: '',
  causes: [],
  improvements: [],
  scope: { labels: [], conditions: '', exclusions: '' },
}

function parseBody(raw: string): DraftBody {
  try {
    const value = JSON.parse(raw) as Partial<DraftBody> | null
    if (!value || typeof value !== 'object') return EMPTY_BODY
    return {
      title: typeof value.title === 'string' ? value.title : '',
      category: typeof value.category === 'string' ? (value.category as DraftBody['category']) : 'other',
      problem: typeof value.problem === 'string' ? value.problem : '',
      causes: Array.isArray(value.causes) ? value.causes as DraftBody['causes'] : [],
      improvements: Array.isArray(value.improvements) ? value.improvements as string[] : [],
      scope: value.scope && typeof value.scope === 'object'
        ? {
            labels: Array.isArray((value.scope as DraftBody['scope']).labels) ? (value.scope as DraftBody['scope']).labels : [],
            conditions: typeof (value.scope as DraftBody['scope']).conditions === 'string' ? (value.scope as DraftBody['scope']).conditions : '',
            exclusions: typeof (value.scope as DraftBody['scope']).exclusions === 'string' ? (value.scope as DraftBody['scope']).exclusions : '',
          }
        : EMPTY_BODY.scope,
    }
  } catch {
    return EMPTY_BODY
  }
}

interface DraftRowLike {
  id: string
  ownerId: string
  sessionId: string
  version: number
  status: string
  action: string
  contentJson: string
  createdAt: Date
  updatedAt: Date
}

interface EvidenceRowLike {
  position: number
  sessionId: string
  messageId: string | null
  runId: string | null
  toolCallId: string | null
  region: string
  startCp: number | null
  endCp: number | null
  excerpt: string
  regionHash: string | null
  contentVersion: string | null
  status: string
  reason: string | null
}

function evidenceOf(rows: readonly EvidenceRowLike[]): EvidenceRecord[] {
  return rows.map((r) => ({
    position: r.position,
    sessionId: r.sessionId,
    messageId: r.messageId,
    runId: r.runId,
    toolCallId: r.toolCallId,
    region: r.region as ReflectionRegion,
    startCp: r.startCp,
    endCp: r.endCp,
    excerpt: r.excerpt,
    regionHash: r.regionHash,
    contentVersion: r.contentVersion,
    status: r.status as EvidenceRecord['status'],
    ...(r.reason !== null ? { reason: r.reason } : {}),
  }))
}

function draftOf(row: DraftRowLike, evidence: readonly EvidenceRowLike[]): DraftRecord {
  return {
    id: row.id,
    ownerId: row.ownerId,
    sessionId: row.sessionId,
    version: row.version,
    status: row.status as ReflectionDraftStatus,
    action: row.action,
    body: parseBody(row.contentJson),
    evidence: evidenceOf(evidence),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export class PrismaReflectionStore implements ReflectionStore, ReflectionEvidencePort {
  constructor(private readonly prisma: PrismaClient) {}

  // ---- 可信当前证据端口 ----

  async read(context: ReflectionContext, sessionId: string, messageId: string): Promise<EvidenceSource | null> {
    // 可信当前证据端口只读本人当前主线程（父规格 I4）：不因模型传了别的 session_id 放宽读取。
    if (sessionId !== context.currentSessionId) return null
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId: context.ownerId, archivedAt: null, isTeammate: false },
      select: { id: true },
    })
    if (!session) return null
    const row = await this.prisma.sessionMessage.findFirst({
      where: { id: messageId, sessionId, archivedAt: null },
      select: { id: true, content: true, attachmentsJson: true, role: true },
    })
    if (!row) return null
    return {
      sessionId,
      messageId,
      region: 'content',
      regionText: row.content,
      contentVersion: contentVersionOf(row.content, row.attachmentsJson),
      truncated: false,
      visible: true,
      regionPresent: true,
    }
  }

  // 证据端口按 region 读取（content 走独立列；thinking/tool 走已保存产品聚合面）。
  async readRegion(context: ReflectionContext, sessionId: string, messageId: string, region: ReflectionRegion, toolCallId?: string): Promise<EvidenceSource | null> {
    const base = await this.read(context, sessionId, messageId)
    if (!base) return null
    if (region === 'content') return base
    const row = await this.prisma.sessionMessage.findFirst({
      where: { id: messageId, sessionId, archivedAt: null },
      select: { attachmentsJson: true, content: true },
    })
    if (!row) return null
    const fields = parseSavedProduct(row.attachmentsJson).fields
    if (region === 'thinking') {
      const thinking = typeof fields.thinking === 'string' ? fields.thinking : undefined
      return {
        ...base,
        region,
        regionText: thinking ?? '',
        regionPresent: thinking !== undefined,
      }
    }
    const tools = Array.isArray(fields.tools) ? fields.tools as Record<string, unknown>[] : []
    const line = tools.find((t) => typeof t.toolCallId === 'string' && t.toolCallId === toolCallId)
    const details = line && typeof line.details === 'string' ? line.details : undefined
    const truncated = line !== undefined && line.truncated === true
    return {
      ...base,
      region,
      regionText: details ?? '',
      regionPresent: details !== undefined,
      truncated,
    }
  }

  // ---- 草稿 ----

  async createDraft(p: {
    ownerId: string
    sessionId: string
    body: DraftBody
    evidence: readonly EvidenceRecord[]
    status: ReflectionDraftStatus
    action: string
  }): Promise<DraftRecord> {
    const created = await this.prisma.$transaction(async (tx) => {
      const draft = await tx.reflectionDraft.create({
        data: {
          ownerId: p.ownerId,
          sessionId: p.sessionId,
          version: 1,
          status: p.status,
          action: p.action,
          title: p.body.title,
          category: p.body.category,
          contentJson: JSON.stringify(p.body),
        },
      })
      await insertEvidenceRows(tx, p.ownerId, draft.id, draft.version, p.evidence)
      return draft
    })
    return draftOf(created, await this.evidenceRows(created.id, created.version))
  }

  async getDraft(ownerId: string, draftId: string): Promise<DraftRecord | null> {
    const row = await this.prisma.reflectionDraft.findFirst({ where: { id: draftId, ownerId } })
    if (!row) return null
    return draftOf(row, await this.evidenceRows(row.id, row.version))
  }

  async reviseDraft(p: {
    ownerId: string
    draftId: string
    baseVersion: number
    body: DraftBody
    evidence: readonly EvidenceRecord[]
    status: ReflectionDraftStatus
  }): Promise<DraftRecord | null> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const current = await tx.reflectionDraft.findFirst({ where: { id: p.draftId, ownerId: p.ownerId } })
      if (!current || current.version !== p.baseVersion) return null
      if (current.status === 'committed' || current.status === 'cancelled') return null
      const version = current.version + 1
      const updated = await tx.reflectionDraft.update({
        where: { id: current.id },
        data: {
          version,
          status: p.status,
          action: 'revise',
          title: p.body.title,
          category: p.body.category,
          contentJson: JSON.stringify(p.body),
        },
      })
      await insertEvidenceRows(tx, p.ownerId, current.id, version, p.evidence)
      // 实质修改：撤销旧展示（父规格 I3）。
      await tx.reflectionPresentation.updateMany({
        where: { ownerId: p.ownerId, draftId: current.id, status: 'active' },
        data: { status: 'revoked', revokedAt: new Date() },
      })
      return updated
    })
    if (!outcome) return null
    return draftOf(outcome, await this.evidenceRows(outcome.id, outcome.version))
  }

  async cancelDraft(ownerId: string, draftId: string): Promise<DraftRecord | null> {
    const closed = await this.prisma.$transaction(async (tx) => {
      const current = await tx.reflectionDraft.findFirst({ where: { id: draftId, ownerId } })
      if (!current || current.status === 'cancelled' || current.status === 'committed') return null
      await tx.reflectionEvidence.deleteMany({ where: { draftId: current.id } })
      await tx.reflectionPresentation.updateMany({
        where: { ownerId, draftId: current.id },
        data: { status: 'deleted', revokedAt: new Date(), bodyJson: '{}' },
      })
      const updated = await tx.reflectionDraft.update({
        where: { id: current.id },
        data: { status: 'cancelled', closedAt: new Date(), contentJson: '{}', title: '' },
      })
      await tx.reflectionEvent.create({
        data: { ownerId, objectId: current.id, action: 'draft_cancel', version: current.version, result: 'ok' },
      })
      return updated
    })
    return closed ? draftOf(closed, []) : null
  }

  async listDrafts(ownerId: string, options: { state?: ReflectionDraftStatus; limit: number }): Promise<DraftRecord[]> {
    const rows = await this.prisma.reflectionDraft.findMany({
      where: { ownerId, ...(options.state !== undefined ? { status: options.state } : {}) },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: options.limit,
    })
    return rows.map((row) => draftOf(row, []))
  }

  // ---- 展示 ----

  async revokePresentations(ownerId: string, draftId: string): Promise<void> {
    await this.prisma.reflectionPresentation.updateMany({
      where: { ownerId, draftId, status: 'active' },
      data: { status: 'revoked', revokedAt: new Date() },
    })
  }

  async createPresentation(p: {
    ownerId: string
    sessionId: string
    draft: DraftRecord
    body: DraftBody
    evidence: readonly EvidenceRecord[]
    bodyJson: string
    bodyHash: string
    action: string
  }): Promise<import('./model').PresentationRecord> {
    const row = await this.prisma.reflectionPresentation.create({
      data: {
        ownerId: p.ownerId,
        sessionId: p.sessionId,
        draftId: p.draft.id,
        draftVersion: p.draft.version,
        action: p.action,
        bodyJson: p.bodyJson,
        bodyHash: p.bodyHash,
        status: 'active',
      },
    })
    return {
      displayId: row.displayId,
      ownerId: row.ownerId,
      sessionId: row.sessionId,
      draftId: row.draftId,
      draftVersion: row.draftVersion,
      action: row.action,
      body: p.body,
      evidence: p.evidence,
      bodyHash: row.bodyHash,
      status: row.status as ReflectionPresentationStatus,
      messageId: null,
      createdAt: row.createdAt.toISOString(),
    }
  }

  // 来源失效：该版本证据标 not_ready、草稿回 preparing（展示/提交须重新起草）。
  async invalidateVersion(ownerId: string, draftId: string, version: number, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.reflectionEvidence.updateMany({
        where: { draftId, draftVersion: version, ownerId },
        data: { status: 'not_ready', reason },
      })
      await tx.reflectionDraft.updateMany({
        where: { id: draftId, ownerId, version },
        data: { status: 'preparing' },
      })
    })
  }

  async getPresentation(ownerId: string, displayId: string): Promise<import('./model').PresentationRecord | null> {
    const row = await this.prisma.reflectionPresentation.findFirst({ where: { displayId, ownerId } })
    if (!row) return null
    return this.presentationRecord(row)
  }

  async latestPresentation(ownerId: string, draftId: string): Promise<import('./model').PresentationRecord | null> {
    const row = await this.prisma.reflectionPresentation.findFirst({
      where: { ownerId, draftId, status: { in: ['active', 'acked'] } },
      orderBy: [{ createdAt: 'desc' }, { displayId: 'desc' }],
    })
    if (!row) return null
    return this.presentationRecord(row)
  }

  private async presentationRecord(row: {
    displayId: string
    ownerId: string
    sessionId: string
    draftId: string
    draftVersion: number
    action: string
    bodyJson: string
    bodyHash: string
    status: string
    messageId: string | null
    createdAt: Date
  }): Promise<import('./model').PresentationRecord> {
    let body: DraftBody | null = EMPTY_BODY
    try {
      const parsed = JSON.parse(row.bodyJson) as { title?: unknown } | null
      body = parsed && typeof parsed === 'object' && typeof parsed.title === 'string'
        ? parseBody(row.bodyJson)
        : null
    } catch {
      body = null
    }
    const evidence = await this.evidenceRows(row.draftId, row.draftVersion)
    return {
      displayId: row.displayId,
      ownerId: row.ownerId,
      sessionId: row.sessionId,
      draftId: row.draftId,
      draftVersion: row.draftVersion,
      action: row.action,
      body: body ?? EMPTY_BODY,
      evidence: evidenceOf(evidence),
      bodyHash: row.bodyHash,
      status: row.status as ReflectionPresentationStatus,
      messageId: row.messageId,
      createdAt: row.createdAt.toISOString(),
    }
  }

  // ---- recordTurn 统一接缝：在飞证据补稳定引用 + 展示绑定终态 assistant 行 ----
  async bindInFlightEvidence(p: {
    ownerId: string
    sessionId: string
    runId: string
    messageId: string
    displayIds?: readonly string[]
  }): Promise<void> {
    const rows = await this.prisma.reflectionEvidence.findMany({
      where: { ownerId: p.ownerId, sessionId: p.sessionId, runId: p.runId, messageId: null, status: 'preparing' },
    })
    if (rows.length > 0) {
      const affected = new Set<string>()
      for (const row of rows) {
        await this.resolveInFlightRow(p, row, affected)
      }
      for (const draftId of affected) {
        const draft = await this.prisma.reflectionDraft.findFirst({ where: { id: draftId, ownerId: p.ownerId } })
        if (!draft || draft.status === 'cancelled' || draft.status === 'committed') continue
        const versionRows = await this.prisma.reflectionEvidence.findMany({
          where: { draftId, draftVersion: draft.version },
          select: { status: true },
        })
        const status = versionRows.length > 0 && versionRows.every((r) => r.status === 'valid') ? 'pending' : 'preparing'
        await this.prisma.reflectionDraft.update({ where: { id: draftId }, data: { status } })
      }
    }
    const displays = [...(p.displayIds ?? [])]
    if (displays.length > 0) {
      // 展示只绑定属于本 owner/本会话的活跃引用；未落进的 display 留给后续 present。
      await this.prisma.reflectionPresentation.updateMany({
        where: { displayId: { in: displays }, ownerId: p.ownerId, sessionId: p.sessionId, status: 'active', messageId: null },
        data: { messageId: p.messageId },
      })
    }
  }

  private async resolveInFlightRow(
    p: { ownerId: string; sessionId: string; messageId: string },
    row: { id: string; toolCallId: string | null; region: string; excerpt: string; startCp: number | null; endCp: number | null },
    affected: Set<string>,
  ): Promise<void> {
    const message = await this.prisma.sessionMessage.findFirst({
      where: { id: p.messageId, sessionId: p.sessionId, archivedAt: null },
      select: { content: true, attachmentsJson: true },
    })
    if (!message) return
    const fields = parseSavedProduct(message.attachmentsJson).fields
    let regionText = ''
    let truncated = false
    let present = true
    if (row.region === 'content') regionText = message.content
    else if (row.region === 'thinking') {
      present = typeof fields.thinking === 'string'
      regionText = present ? fields.thinking as string : ''
    } else {
      const tools = Array.isArray(fields.tools) ? fields.tools as Record<string, unknown>[] : []
      const line = tools.find((t) => typeof t.toolCallId === 'string' && t.toolCallId === row.toolCallId)
      present = line !== undefined && typeof line.details === 'string'
      regionText = present ? line!.details as string : ''
      truncated = line !== undefined && line.truncated === true
    }
    const contentVersion = contentVersionOf(message.content, message.attachmentsJson)
    const base = { messageId: p.messageId, contentVersion }
    if (!present) {
      await this.prisma.reflectionEvidence.update({ where: { id: row.id }, data: { ...base, status: 'not_ready', reason: 'not_persisted' } })
    } else {
      const matched = matchExcerpt(regionText, row.excerpt, row.startCp ?? undefined, row.endCp ?? undefined)
      if ('error' in matched) {
        await this.prisma.reflectionEvidence.update({
          where: { id: row.id },
          data: { ...base, status: 'not_ready', reason: truncated ? 'truncated' : 'not_found' },
        })
      } else {
        await this.prisma.reflectionEvidence.update({
          where: { id: row.id },
          data: {
            ...base,
            status: 'valid',
            reason: null,
            startCp: matched.start,
            endCp: matched.end,
            regionHash: matched.regionHash,
          },
        })
      }
    }
    // 该证据所属草稿当前版本需要重算状态。
    const evidence = await this.prisma.reflectionEvidence.findUnique({ where: { id: row.id }, select: { draftId: true } })
    if (evidence) affected.add(evidence.draftId)
  }

  // ---- ack（单调序号 = reflection_events AUTOINCREMENT；ack 不是写授权）----

  async ackPresentation(p: {
    ownerId: string
    displayId: string
    version: number
    bodyHash: string
    messageId: string
  }): Promise<{ seq: number; ackedAt: string } | { error: 'not_found' | 'conflict' | 'not_ready' }> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.reflectionPresentation.findFirst({ where: { displayId: p.displayId, ownerId: p.ownerId } })
      if (!row) return { error: 'not_found' as const }
      if (row.draftVersion !== p.version || row.bodyHash !== p.bodyHash) return { error: 'conflict' as const }
      if (row.messageId === null || row.status === 'revoked' || row.status === 'deleted') return { error: 'not_ready' as const }
      if (row.messageId !== p.messageId) return { error: 'conflict' as const }
      if (row.ackSeq !== null && row.ackedAt !== null) {
        return { seq: row.ackSeq, ackedAt: row.ackedAt.toISOString() }
      }
      const message = await tx.sessionMessage.findFirst({
        where: { id: p.messageId, sessionId: row.sessionId, archivedAt: null, role: 'assistant' },
        select: { attachmentsJson: true },
      })
      if (!message) return { error: 'not_found' as const }
      const presentations = parseSavedProduct(message.attachmentsJson).fields.presentations
      const bound = Array.isArray(presentations) && presentations.some((ref) => {
        const item = ref as Record<string, unknown> | null
        return item !== null && typeof item === 'object' && item.displayId === row.displayId && item.version === row.draftVersion
      })
      if (!bound) return { error: 'conflict' as const }
      const event = await tx.reflectionEvent.create({
        data: { ownerId: p.ownerId, objectId: row.displayId, action: 'display_ack', version: row.draftVersion, result: 'ok' },
      })
      const updated = await tx.reflectionPresentation.update({
        where: { displayId: row.displayId },
        data: { status: 'acked', ackSeq: event.seq, ackedAt: new Date() },
      })
      return { seq: event.seq, ackedAt: updated.ackedAt!.toISOString() }
    })
  }

  private async evidenceRows(draftId: string, version: number): Promise<EvidenceRowLike[]> {
    return this.prisma.reflectionEvidence.findMany({
      where: { draftId, draftVersion: version },
      orderBy: { position: 'asc' },
    })
  }
}

// 服务端核验用的 region 读取需要一个显式 region 参数；业务 service 的 port 只 expose read。
// 保留导出以便 #1081+ 的确认授权复用同一适配。

// 证据行插入（createDraft/reviseDraft 共用同一字段映射；版本化行不更新旧版本）。
type ReflectionTx = import('../generated/prisma/client').Prisma.TransactionClient

async function insertEvidenceRows(
  tx: ReflectionTx,
  ownerId: string,
  draftId: string,
  draftVersion: number,
  evidence: readonly EvidenceRecord[],
): Promise<void> {
  for (const e of evidence) {
    await tx.reflectionEvidence.create({
      data: {
        draftId,
        draftVersion,
        position: e.position,
        ownerId,
        sessionId: e.sessionId,
        messageId: e.messageId,
        runId: e.runId,
        toolCallId: e.toolCallId,
        region: e.region,
        startCp: e.startCp,
        endCp: e.endCp,
        excerpt: e.excerpt,
        regionHash: e.regionHash,
        contentVersion: e.contentVersion,
        status: e.status,
        reason: e.reason ?? null,
      },
    })
  }
}
