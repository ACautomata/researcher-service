// reflections 外层适配（#1080 · RF-T04）：Prisma/SQLite 存储 + 可信当前证据端口。
//
// 内层 service 不依赖 Prisma；本适配负责归属过滤、事务、展示绑定与 ack 单调序号
// （reflection_events AUTOINCREMENT）。草稿正文与正式经验存储分离，草稿绝不进入 experience 检索。

import { ReflectionDraftLimitError } from './lifecycle'
import { isLifecycleAction } from './lifecycle'
import { purgeDraftCopies, hardDeleteRecord } from './retention'
import type { PrismaClient } from '../generated/prisma/client'
import { parseSavedProduct } from '../sessions/productMessage'
import { contentVersionOf, matchExcerpt, presentationJson, sha256 } from './content'
import type {
  CommitOutcome,
  CommitResult,
  ConfirmationCandidate,
  DraftBody,
  DraftRecord,
  EvidenceRecord,
  EvidenceSource,
  GrantRecord,
  ReflectionContext,
  ReflectionEvidencePort,
  ReflectionStore,
  ReflectionTriggerMessage,
  RecordDetail,
  ReflectionTarget,
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
  targetsJson?: string | null
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
    targets: JSON.parse(row.targetsJson ?? '[]'),
    body: parseBody(row.contentJson),
    evidence: evidenceOf(evidence),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// 事务客户端与普通读客户端共用相同原始产品投影读取；无需把事务强转完整 PrismaClient。
class PrismaReflectionEvidence implements ReflectionEvidencePort {
  constructor(private readonly prisma: Pick<PrismaClient, 'session' | 'sessionMessage'>) {}

  async read(context: ReflectionContext, sessionId: string, messageId: string): Promise<EvidenceSource | null> {
    // 已持久证据只读本人主线程会话；草稿阶段「只能引用当前会话」的边界在 service.resolveEvidence，
    // 此处放宽到本人任意未归档会话是为了跨会话重新展示时复核旧证据（不扩大跨用户/子助手权限）。
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

}

export class PrismaReflectionStore implements ReflectionStore, ReflectionEvidencePort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: {
      /** 故障注入（RF18）：事件写失败必须整笔回滚，不得留下半套正式结果。 */
      failEventWrite?: (action: string) => boolean
      /** 事务前屏障：验证独立连接与提交的真实交错；不替换 repository 或 SQLite。 */
      beforeCommitTransaction?: () => Promise<void>
      clock?: () => number
      failEpisodeRead?: () => boolean
    } = {},
  ) {}

  // ---- 可信当前证据端口 ----

  read(context: ReflectionContext, sessionId: string, messageId: string): Promise<EvidenceSource | null> {
    return new PrismaReflectionEvidence(this.prisma).read(context, sessionId, messageId)
  }

  readRegion(context: ReflectionContext, sessionId: string, messageId: string, region: ReflectionRegion, toolCallId?: string): Promise<EvidenceSource | null> {
    return new PrismaReflectionEvidence(this.prisma).readRegion(context, sessionId, messageId, region, toolCallId)
  }

  async analysisCompleted(context: ReflectionContext): Promise<boolean> {
    if (this.options.failEpisodeRead?.()) throw new Error('episode metadata unavailable')
    if (!context.requestId || context.role !== 'leader') return false
    return (await this.prisma.reflectionEpisode.count({ where: { ownerId: context.ownerId, sessionId: context.currentSessionId, requestId: context.requestId, draftId: null } })) > 0
  }

  async completeAnalysis(context: ReflectionContext): Promise<void> {
    if (!context.requestId || context.role !== 'leader') return
    const id = sha256(JSON.stringify(['completed', context.ownerId, context.requestId]))
    await this.prisma.reflectionEpisode.upsert({ where: { id }, update: {}, create: {
      id, ownerId: context.ownerId, sessionId: context.currentSessionId, requestId: context.requestId,
    } })
  }

  // ---- 草稿 ----

  async createDraft(p: {
    ownerId: string
    sessionId: string
    body: DraftBody
    evidence: readonly EvidenceRecord[]
    status: ReflectionDraftStatus
    action: string
    targets?: readonly ReflectionTarget[]
    episode?: { id: string; requestId: string }
  }): Promise<DraftRecord> {
    const created = await this.prisma.$transaction(async (tx) => {
      if (p.episode) {
        const episode = await tx.reflectionEpisode.findUnique({ where: { id: p.episode.id } })
        if (episode) {
          const previous = await tx.reflectionDraft.findFirst({ where: { id: episode.draftId ?? '', ownerId: p.ownerId } })
          if (!previous) throw new Error('episode reference unavailable')
          return { ...previous, alreadyAnalyzed: true }
        }
      }
      if ((await this.targetDifferences(tx, p.ownerId, p.targets ?? [])).length) throw new Error('stale reflection targets')
      const now = new Date(this.options.clock?.() ?? Date.now())
      const active = await tx.reflectionDraft.count({ where: { ownerId: p.ownerId, status: { in: ['preparing', 'pending', 'confirmed_pending_save'] } } })
      const recent = await tx.reflectionDraft.count({ where: { ownerId: p.ownerId, createdAt: { gt: new Date(now.getTime() - 86400000) } } })
      if (active >= 100 || recent >= 100) throw new ReflectionDraftLimitError()
      const draft = await tx.reflectionDraft.create({
        data: {
          ownerId: p.ownerId,
          sessionId: p.sessionId,
          createdAt: now,
          version: 1,
          status: p.status,
          action: p.action,
          targetsJson: JSON.stringify(p.targets ?? []),
          title: p.body.title,
          category: p.body.category,
          contentJson: JSON.stringify(p.body),
        },
      })
      await insertEvidenceRows(tx, p.ownerId, draft.id, draft.version, p.evidence)
      if (p.episode) await tx.reflectionEpisode.create({ data: {
        id: p.episode.id, ownerId: p.ownerId, sessionId: p.sessionId, requestId: p.episode.requestId, draftId: draft.id,
      } })
      return { ...draft, alreadyAnalyzed: false }
    })
    return { ...draftOf(created, await this.evidenceRows(created.id, created.version)), alreadyAnalyzed: created.alreadyAnalyzed }
  }

  async getDraft(ownerId: string, draftId: string): Promise<DraftRecord | null> {
    // 单读事务快照：正文与证据版本必须一致——并发来源失效提交后不交付「旧正文 + 新证据」
    // 的混合视图（父规格 I4：查询与变更并发时二次复核不交付已封锁正文）。
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.reflectionDraft.findFirst({ where: { id: draftId, ownerId } })
      if (!row) return null
      const evidence = await tx.reflectionEvidence.findMany({
        where: { draftId: row.id, draftVersion: row.version },
        orderBy: { position: 'asc' },
      })
      return draftOf(row, evidence)
    })
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
      if (!['pending', 'preparing', 'confirmed_pending_save'].includes(current.status)) return null
      const version = current.version + 1
      const updated = await tx.reflectionDraft.update({
        where: { id: current.id },
        data: {
          version,
          status: p.status,
          action: current.targetsJson && current.targetsJson !== '[]' ? current.action : 'revise',
          title: p.body.title,
          category: p.body.category,
          contentJson: JSON.stringify(p.body),
        },
      })
      await insertEvidenceRows(tx, p.ownerId, current.id, version, p.evidence)
      // 实质修改：撤销旧展示与未消费授权（父规格 I3）。
      await tx.reflectionGrant.updateMany({
        where: { ownerId: p.ownerId, draftId: current.id, status: 'active' },
        data: { status: 'revoked' },
      })
      await tx.reflectionPresentation.updateMany({
        where: { ownerId: p.ownerId, draftId: current.id, status: { in: ['active', 'acked'] } },
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
      await tx.reflectionGrant.updateMany({
        where: { ownerId, draftId: current.id, status: 'active' },
        data: { status: 'revoked' },
      })
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
    // #1084：管理检索需要在交付前按失效摘录清理标题/正文，故连当前版本证据一起读快照。
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.reflectionDraft.findMany({
        where: { ownerId, ...(options.state !== undefined ? { status: options.state } : {}) },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: options.limit,
      })
      const out: DraftRecord[] = []
      for (const row of rows) {
        out.push(draftOf(row, await tx.reflectionEvidence.findMany({
          where: { draftId: row.id, draftVersion: row.version },
          orderBy: { position: 'asc' },
        })))
      }
      return out
    })
  }

  // ---- 展示 ----

  async revokePresentations(ownerId: string, draftId: string): Promise<void> {
    await this.prisma.reflectionPresentation.updateMany({
      // 已 acked 的旧展示同样失效：重新展示后须重新 ack，避免同版本多候选。
      where: { ownerId, draftId, status: { in: ['active', 'acked'] } },
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
    const row = await this.prisma.$transaction(async tx => {
      const draft = await tx.reflectionDraft.findFirst({ where: { id: p.draft.id, ownerId: p.ownerId, version: p.draft.version, status: { in: ['preparing', 'pending', 'confirmed_pending_save'] } } })
      if (!draft || draft.contentJson !== JSON.stringify(p.draft.body) ||
          (await this.targetDifferences(tx, p.ownerId, p.draft.targets ?? [])).length) throw new Error('stale reflection display')
      return tx.reflectionPresentation.create({
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
        where: { id: draftId, ownerId, version, status: { in: ['preparing', 'pending', 'confirmed_pending_save'] } },
        data: { status: 'preparing' },
      })
    })
  }

  async getPresentation(ownerId: string, displayId: string): Promise<import('./model').PresentationRecord | null> {
    const row = await this.prisma.reflectionPresentation.findFirst({ where: { displayId, ownerId } })
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
        if (!draft || !['preparing', 'pending', 'confirmed_pending_save'].includes(draft.status)) continue
        const versionRows = await this.prisma.reflectionEvidence.findMany({
          where: { draftId, draftVersion: draft.version },
          select: { status: true },
        })
        const status = versionRows.length > 0 && versionRows.every((r) => r.status === 'valid') ? 'pending' : 'preparing'
        await this.prisma.reflectionDraft.updateMany({ where: { id: draftId, status: { in: ['preparing', 'pending', 'confirmed_pending_save'] } }, data: { status } })
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
      // 服务端单调序号：ack 时刻会话最大 turn。之后的用户消息 turn 必更大；
      // 若确认消息早于 ack 入列，其 turn ≤ ackTurn，不能事后补 ack 追认。
      const maxTurn = await tx.sessionMessage.aggregate({ where: { sessionId: row.sessionId }, _max: { turn: true } })
      const event = await tx.reflectionEvent.create({
        data: { ownerId: p.ownerId, objectId: row.displayId, action: 'display_ack', version: row.draftVersion, result: 'ok' },
      })
      const updated = await tx.reflectionPresentation.update({
        where: { displayId: row.displayId },
        data: { status: 'acked', ackSeq: event.seq, ackTurn: maxTurn._max.turn ?? null, ackedAt: new Date() },
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

  // ---- 确认授权（#1081 · RF-T05）----

  async getTriggerMessage(ownerId: string, sessionId: string, messageId: string): Promise<ReflectionTriggerMessage | null> {
    const row = await this.prisma.sessionMessage.findFirst({
      where: {
        id: messageId,
        sessionId,
        role: 'user',
        archivedAt: null,
        session: { ownerId, archivedAt: null, isTeammate: false },
      },
      select: { id: true, turn: true, content: true },
    })
    return row ?? null
  }

  async confirmationCandidates(ownerId: string, sessionId: string, beforeTurn: number): Promise<ConfirmationCandidate[]> {
    const rows = await this.prisma.reflectionPresentation.findMany({
      where: { ownerId, sessionId, status: 'acked', messageId: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { displayId: 'asc' }],
    })
    const out: ConfirmationCandidate[] = []
    for (const row of rows) {
      if (row.messageId === null || row.ackSeq === null || row.ackTurn === null) continue
      // 确认消息必须晚于该版本有效 ack（ackTurn = ack 时刻会话最大 turn）。
      if (row.ackTurn >= beforeTurn) continue
      // 确认消息必须晚于展示绑定的终态 assistant 行（服务端单调 turn，不猜同毫秒时间戳）。
      const bound = await this.prisma.sessionMessage.findFirst({
        where: { id: row.messageId, sessionId, role: 'assistant', archivedAt: null, turn: { lt: beforeTurn } },
        select: { turn: true },
      })
      if (!bound) continue
      const draftRow = await this.prisma.reflectionDraft.findFirst({
        where: { id: row.draftId, ownerId, version: row.draftVersion, status: { in: ['pending', 'confirmed_pending_save'] } },
      })
      if (!draftRow) continue
      const evidence = await this.evidenceRows(row.draftId, row.draftVersion)
      if (!isLifecycleAction(draftRow.action) && (evidence.length === 0 || !evidence.every((e) => e.status === 'valid'))) continue
      out.push({
        presentation: await this.presentationRecord(row),
        draft: draftOf(draftRow, evidence),
      })
    }
    return out
  }

  async recentUserMessages(ownerId: string, sessionId: string, beforeTurn: number, limit: number): Promise<string[]> {
    const rows = await this.prisma.sessionMessage.findMany({
      where: { sessionId, role: 'user', archivedAt: null, turn: { lt: beforeTurn }, session: { ownerId } },
      orderBy: { turn: 'desc' },
      take: limit,
      select: { content: true },
    })
    return rows.map((r) => r.content).reverse()
  }

  private async targetDifferences(tx: ReflectionTx, ownerId: string, targets: readonly ReflectionTarget[]): Promise<unknown[]> {
    const differences: unknown[] = []
    for (const target of targets) {
      const row = await tx.reflectionRecord.findFirst({ where: { id: target.record_id, ownerId } })
      const actual = row ? await this.recordDetail(tx, row) : null
      if (!actual || actual.currentRevision !== target.version || actual.generation !== target.generation ||
          actual.status !== target.status || actual.evidenceStatus !== target.evidence_status ||
          sha256(JSON.stringify(actual.evidence)) !== target.evidence_hash) {
        differences.push({ record_id: target.record_id, expected_version: target.version,
          actual_version: actual?.currentRevision ?? null, expected_generation: target.generation,
          actual_generation: actual?.generation ?? null, status: actual?.status ?? 'unreadable',
          evidence_status: actual?.evidenceStatus ?? 'unreadable' })
      }
    }
    return differences
  }

  private async validEvidence(tx: ReflectionTx, ownerId: string, sessionId: string, evidence: readonly EvidenceRecord[]): Promise<boolean> {
    const port = new PrismaReflectionEvidence(tx)
    for (const e of evidence) {
      if (e.status !== 'valid' || !e.messageId) return false
      const source = await port.readRegion({ ownerId, currentSessionId: sessionId, role: 'leader' }, e.sessionId, e.messageId, e.region, e.toolCallId ?? undefined)
      if (!source || !source.regionPresent || !source.visible || source.contentVersion !== e.contentVersion) return false
      // 脱敏摘录不等于原文；区域 hash 与版本仍必须完全一致。
      if (sha256(source.regionText) !== e.regionHash) return false
    }
    return evidence.length > 0
  }

  async issueGrant(p: {
    ownerId: string
    sessionId: string
    confirmationMessageId: string
    confirmationTurn: number
    candidate: ConfirmationCandidate
    expiresAt: Date
  }): Promise<GrantRecord | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // 同一确认消息重复识别（恢复/重试）返回既有授权；已撤回/过窗的旧消息不再重签。
        const existing = await tx.reflectionGrant.findFirst({
          where: { ownerId: p.ownerId, confirmationMessageId: p.confirmationMessageId },
        })
        if (existing) {
          return existing.status === 'active' || existing.status === 'consumed' ? grantOf(existing) : null
        }
        // 一条消息一个完整动作：草稿已有其它未消费授权时不重复签发。
        const activeGrant = await tx.reflectionGrant.findFirst({
          where: { ownerId: p.ownerId, draftId: p.candidate.draft.id, status: 'active' },
        })
        if (activeGrant) return null
        const presentation = await tx.reflectionPresentation.findFirst({
          where: { displayId: p.candidate.presentation.displayId, ownerId: p.ownerId, sessionId: p.sessionId, status: 'acked' },
        })
        if (
          !presentation ||
          presentation.messageId === null ||
          presentation.ackSeq === null ||
          presentation.ackTurn === null ||
          presentation.ackTurn >= p.confirmationTurn ||
          presentation.draftVersion !== p.candidate.draft.version ||
          presentation.bodyHash !== p.candidate.presentation.bodyHash
        ) return null
        const draft = await tx.reflectionDraft.findFirst({
          where: { id: p.candidate.draft.id, ownerId: p.ownerId, version: p.candidate.draft.version, status: 'pending' },
        })
        if (!draft) return null
        if ((await this.targetDifferences(tx, p.ownerId, JSON.parse(draft.targetsJson ?? '[]'))).length) return null
        const evidence = await tx.reflectionEvidence.findMany({ where: { draftId: draft.id, draftVersion: draft.version } })
        if (!isLifecycleAction(draft.action) && !await this.validEvidence(tx, p.ownerId, draft.sessionId, evidenceOf(evidence))) return null
        // CAS：草稿仍 pending 才进入待保存；并发修订/取消整体失败，无部分授权。
        const moved = await tx.reflectionDraft.updateMany({
          where: { id: draft.id, ownerId: p.ownerId, version: draft.version, status: 'pending' },
          data: { status: 'confirmed_pending_save' },
        })
        if (moved.count !== 1) return null
        await tx.reflectionEvent.create({
          data: { ownerId: p.ownerId, objectId: draft.id, action: 'grant_issued', version: draft.version, result: 'ok' },
        })
        const grant = await tx.reflectionGrant.create({
          data: {
            ownerId: p.ownerId,
            sessionId: p.sessionId,
            confirmationMessageId: p.confirmationMessageId,
            displayId: presentation.displayId,
            draftId: draft.id,
            draftVersion: draft.version,
            bodyHash: presentation.bodyHash,
            action: presentation.action,
            ackSeq: presentation.ackSeq,
            expiresAt: p.expiresAt,
          },
        })
        return grantOf(grant)
      })
    } catch (err) {
      // 同一确认消息并发签发：唯一约束败方读回既有 grant（幂等）。
      if ((err as { code?: string }).code === 'P2002') {
        const existing = await this.prisma.reflectionGrant.findFirst({
          where: { ownerId: p.ownerId, confirmationMessageId: p.confirmationMessageId },
        })
        return existing ? grantOf(existing) : null
      }
      throw err
    }
  }

  private async committedOutcome(
    client: Pick<PrismaClient, 'reflectionIdempotency' | 'reflectionGrant' | 'reflectionRecord'>,
    p: Parameters<ReflectionStore['commitGrant']>[0],
    key: string,
  ): Promise<CommitOutcome | null> {
    const existing = await client.reflectionIdempotency.findUnique({ where: { key } })
    if (!existing) return null
    const grant = await client.reflectionGrant.findFirst({ where: {
      ownerId: p.ownerId, confirmationMessageId: p.confirmationMessageId, draftId: p.draftId, draftVersion: p.draftVersion,
    } })
    if (!grant) return { error: 'not_found' }
    const record = await client.reflectionRecord.findFirst({ where: { id: existing.recordId, ownerId: p.ownerId, status: { not: 'deleted' } } })
    if (!record) return { error: 'revoked' }
    return { result: parseCommitResult(existing.resultJson), idempotent: true }
  }

  async commitGrant(p: {
    ownerId: string
    confirmationMessageId: string
    draftId: string
    draftVersion: number
    now: Date
    signal?: AbortSignal
  }): Promise<CommitOutcome> {
    await this.options.beforeCommitTransaction?.()
    if (p.signal?.aborted) return { error: 'cancelled' }
    const key = idempotencyKey(p.ownerId, p.confirmationMessageId)
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (p.signal?.aborted) return { error: 'cancelled' as const }
        const saved = await this.committedOutcome(tx, p, key)
        if (saved) return saved
        const grant = await tx.reflectionGrant.findFirst({
          where: {
            ownerId: p.ownerId,
            confirmationMessageId: p.confirmationMessageId,
            draftId: p.draftId,
            draftVersion: p.draftVersion,
          },
        })
        if (!grant) return { error: 'not_found' as const }
        if (grant.status === 'revoked') return { error: 'revoked' as const }
        if (grant.status === 'expired') return { error: 'expired' as const }
        if (grant.status === 'consumed') return { error: 'not_found' as const }
        // 确认消息与展示绑定行必须仍活跃（撤回/rewind 归档即撤销未消费授权）。
        const confirmation = await tx.sessionMessage.findFirst({
          where: { id: p.confirmationMessageId, sessionId: grant.sessionId, role: 'user', archivedAt: null },
          select: { id: true },
        })
        const presentation = await tx.reflectionPresentation.findFirst({
          where: { displayId: grant.displayId, ownerId: p.ownerId },
        })
        const bound = presentation?.messageId
          ? await tx.sessionMessage.findFirst({ where: { id: presentation.messageId, archivedAt: null }, select: { id: true } })
          : null
        if (
          !confirmation ||
          !presentation ||
          presentation.messageId === null ||
          presentation.status === 'revoked' ||
          presentation.status === 'deleted' ||
          !bound
        ) {
          await releaseGrant(tx, { ownerId: p.ownerId, grant, now: p.now, status: 'revoked' })
          return { error: 'revoked' as const }
        }
        if (grant.expiresAt.getTime() <= p.now.getTime()) {
          // 过窗：撤授权、草稿回 pending、旧展示撤销——必须重新展示后再次确认。
          await releaseGrant(tx, { ownerId: p.ownerId, grant, now: p.now, status: 'expired' })
          return { error: 'expired' as const }
        }
        if (grant.submissions >= 3) return { error: 'limit' as const }
        // 失败尝试也计数（本事务返回错误值时随事务提交）；CAS：只有仍 active 且未达上限才计数。
        const bumped = await tx.reflectionGrant.updateMany({
          where: { id: grant.id, status: 'active', submissions: { lt: 3 } },
          data: { submissions: { increment: 1 } },
        })
        if (bumped.count !== 1) return { error: 'conflict' as const }

        const draftRow = await tx.reflectionDraft.findFirst({
          where: { id: p.draftId, ownerId: p.ownerId, version: p.draftVersion },
        })
        if (!draftRow || draftRow.status !== 'confirmed_pending_save') return { error: 'conflict' as const }
        const evidenceRows = await tx.reflectionEvidence.findMany({
          where: { draftId: p.draftId, draftVersion: p.draftVersion },
          orderBy: { position: 'asc' },
        })
        if (!isLifecycleAction(grant.action) && (evidenceRows.length === 0 || !evidenceRows.every((r) => r.status === 'valid'))) {
          return { error: 'conflict' as const }
        }
        // 正式保存的正文必须与用户实际看到的版本逐字一致（服务端重算 hash）。
        const body = parseBody(draftRow.contentJson)
        const evidence = evidenceOf(evidenceRows)
        const targets: ReflectionTarget[] = JSON.parse(draftRow.targetsJson ?? '[]')
        const differences = await this.targetDifferences(tx, p.ownerId, targets)
        if (differences.length) return { error: 'conflict' as const, differences }
        // 权限、原始产品投影版本、范围 hash 都在写事务内重读，封闭事务外复核后的竞态。
        if (!isLifecycleAction(grant.action) && !await this.validEvidence(tx, p.ownerId, draftRow.sessionId, evidence)) return { error: 'conflict' as const }
        const bodyJson = presentationJson({ body, evidence, version: draftRow.version, action: grant.action, targets })
        const bodyHash = sha256(bodyJson)
        if (bodyHash !== grant.bodyHash) return { error: 'conflict' as const }

        if (isLifecycleAction(grant.action)) {
          const target = targets[0]
          if (targets.length !== 1 || !target ||
              (grant.action === 'reactivate' && target.status !== 'inactive') ||
              (grant.action === 'deactivate' && target.status !== 'active')) return { error: 'conflict' as const }
          const status = grant.action === 'delete' ? 'deleted' : grant.action === 'deactivate' ? 'inactive' : 'active'
          if (status === 'deleted') await hardDeleteRecord(tx, p.ownerId, target.record_id, p.now)
          else await tx.reflectionRecord.update({ where: { id: target.record_id }, data: { status, generation: { increment: 1 } } })
          const result: CommitResult = { recordId: target.record_id, revision: target.version,
            title: status === 'deleted' ? '' : draftRow.title, category: status === 'deleted' ? 'other' : draftRow.category,
            status, evidenceStatus: target.evidence_status }
          if (this.options.failEventWrite?.('record_commit')) throw new Error('injected event write failure')
          await tx.reflectionEvent.create({ data: { ownerId: p.ownerId, objectId: target.record_id, action: `record_${grant.action}`, version: target.version, result: 'ok' } })
          if (status !== 'deleted') await tx.reflectionIdempotency.create({ data: { key, ownerId: p.ownerId, recordId: target.record_id, resultJson: JSON.stringify(result) } })
          await tx.reflectionGrant.update({ where: { id: grant.id }, data: { status: 'consumed', consumedAt: p.now } })
          if (status !== 'deleted') await tx.reflectionDraft.update({ where: { id: draftRow.id }, data: { status: 'committed', closedAt: p.now, committedRecordId: target.record_id } })
          return { result, idempotent: false }
        }
        const modifies = targets.length === 1 && ['revise', 'review'].includes(grant.action)
        const revision = modifies ? targets[0].version + 1 : 1
        const data = {
          title: draftRow.title, category: draftRow.category, contentJson: draftRow.contentJson,
          status: modifies ? targets[0].status : 'active', evidenceStatus: 'valid', currentRevision: revision,
        }
        const record = modifies
          ? await tx.reflectionRecord.update({ where: { id: targets[0].record_id }, data })
          : await tx.reflectionRecord.create({ data: { ...data, ownerId: p.ownerId, sessionId: draftRow.sessionId, generation: 1 } })
        // 新目标只由服务端分配，旧源不可再次充当新关系目标，因此替代/合并 DAG 构造性无环。
        if (['replace', 'merge'].includes(grant.action)) {
          await tx.reflectionRecord.updateMany({
            where: { ownerId: p.ownerId, id: { in: targets.map(t => t.record_id) } },
            data: { status: 'superseded' },
          })
        }
        await tx.reflectionRevision.create({
          data: {
            recordId: record.id,
            version: revision,
            bodyJson,
            bodyHash,
            evidenceJson: JSON.stringify(evidence),
          },
        })
        // #1084（RF-T08）：结构化证据引用独立存储（无会话/消息外键）——源会话删除后仍可
        // 复核/封锁，不依赖会随会话级联消失的草稿证据行。
        await tx.reflectionRecordEvidence.createMany({
          data: evidence.map((e) => ({
            recordId: record.id,
            recordVersion: revision,
            position: e.position,
            ownerId: p.ownerId,
            sessionId: e.sessionId,
            messageId: e.messageId,
            toolCallId: e.toolCallId,
            region: e.region,
            startCp: e.startCp,
            endCp: e.endCp,
            excerpt: e.excerpt,
            regionHash: e.regionHash,
            contentVersion: e.contentVersion,
            status: 'valid',
          })),
        })
        // 运维事件写失败 → 整笔回滚（不留下无事件的正式结果）。
        if (this.options.failEventWrite?.('record_commit')) throw new Error('injected event write failure')
        await tx.reflectionEvent.create({
          data: { ownerId: p.ownerId, objectId: record.id, action: 'record_commit', version: revision, result: 'ok' },
        })
        const result: CommitResult = {
          recordId: record.id,
          revision,
          title: record.title,
          category: record.category,
          status: record.status,
          evidenceStatus: record.evidenceStatus,
        }
        await tx.reflectionIdempotency.create({
          data: { key, ownerId: p.ownerId, recordId: record.id, resultJson: JSON.stringify(result) },
        })
        const consumed = await tx.reflectionGrant.updateMany({
          where: { id: grant.id, status: 'active' },
          data: { status: 'consumed', consumedAt: p.now },
        })
        // 消费 CAS 失败 = 并发已改变授权；整笔回滚，不产生半套正式结果。
        if (consumed.count !== 1) throw new Error('reflection grant consumed concurrently')
        await tx.reflectionDraft.update({ where: { id: draftRow.id }, data: { status: 'committed', closedAt: p.now, committedRecordId: record.id } })
        return { result, idempotent: false }
      })
    } catch (err) {
      // 并发重复提交：唯一约束败方读回已提交结果（结果未知后查实况）。
      if ((err as { code?: string }).code === 'P2002') {
        const saved = await this.committedOutcome(this.prisma, p, key)
        if (saved) return saved
      }
      throw err
    }
  }

  async applyDecision(p: {
    ownerId: string
    draftId: string
    decision: 'reject' | 'revise' | 'withdraw'
    now: Date
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const draft = await tx.reflectionDraft.findFirst({ where: { id: p.draftId, ownerId: p.ownerId } })
      if (!draft) return
      // 未提交的确认一律撤销；已消费的授权不动（已提交记录独立保留）。
      await tx.reflectionGrant.updateMany({
        where: { ownerId: p.ownerId, draftId: draft.id, status: 'active' },
        data: { status: 'revoked' },
      })
      await tx.reflectionPresentation.updateMany({
        where: { ownerId: p.ownerId, draftId: draft.id, status: { in: ['active', 'acked'] } },
        data: { status: 'revoked', revokedAt: p.now },
      })
      if (draft.status === 'committed' || draft.status === 'cancelled' || draft.status === 'rejected') return
      if (p.decision === 'reject' || p.decision === 'withdraw') {
        await purgeDraftCopies(tx, p.ownerId, [draft.id], p.now, p.decision === 'reject' ? 'rejected' : 'cancelled')
        await tx.reflectionDraft.update({
          where: { id: draft.id },
          data: { status: p.decision === 'reject' ? 'rejected' : 'cancelled', closedAt: p.now, contentJson: '{}', title: '' },
        })
      } else {
        // revise：保留正文供 Leader 修订/重新展示，但必须重新展示确认。
        await tx.reflectionDraft.update({ where: { id: draft.id }, data: { status: 'pending' } })
      }
      await tx.reflectionEvent.create({
        data: { ownerId: p.ownerId, objectId: draft.id, action: `draft_${p.decision}`, version: draft.version, result: 'ok' },
      })
    })
  }

  async revokeActiveGrants(ownerId: string, draftId: string): Promise<void> {
    await this.prisma.reflectionGrant.updateMany({
      where: { ownerId, draftId, status: 'active' },
      data: { status: 'revoked' },
    })
  }

  // ---- 正式记录管理读取（#1084 · RF-T08）----

  async listRecords(ownerId: string, options: { purpose: 'experience' | 'management'; limit: number }): Promise<RecordDetail[]> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.reflectionRecord.findMany({
        // experience 仅 active + valid：任一支撑失效即退出主动使用（父规格 I4）。
        where: {
          ownerId,
          ...(options.purpose === 'experience' ? { status: 'active', evidenceStatus: 'valid' } : {}),
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: options.limit,
      })
      const out: RecordDetail[] = []
      for (const row of rows) out.push(await this.recordDetail(tx, row))
      return out
    })
  }

  async getRecord(ownerId: string, recordId: string, version?: number): Promise<RecordDetail | null> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.reflectionRecord.findFirst({ where: { id: recordId, ownerId } })
      if (!row) return null
      return this.recordDetail(tx, row, version)
    })
  }

  private async recordDetail(tx: ReflectionTx, row: {
    id: string
    ownerId: string
    sessionId: string
    title: string
    category: string
    contentJson: string
    status: string
    evidenceStatus: string
    currentRevision: number
    generation: number
    createdAt: Date
    updatedAt: Date
  }, version?: number): Promise<RecordDetail> {
    const target = version ?? row.currentRevision
    // 记录正文/版本/证据同一读事务快照（并发失效提交时不混用新旧状态）。
    const revision = await tx.reflectionRevision.findUnique({
      where: { recordId_version: { recordId: row.id, version: target } },
    })
    const evidenceRows = await tx.reflectionRecordEvidence.findMany({
      where: { recordId: row.id, recordVersion: revision?.version ?? target },
      orderBy: { position: 'asc' },
    })
    const body = revision ? parseBody(revision.bodyJson) : parseBody(row.contentJson)
    const evidence = evidenceRows.map((e) => ({
      position: e.position,
      sessionId: e.sessionId,
      messageId: e.messageId,
      toolCallId: e.toolCallId,
      region: e.region as ReflectionRegion,
      startCp: e.startCp,
      endCp: e.endCp,
      excerpt: e.excerpt,
      regionHash: e.regionHash,
      contentVersion: e.contentVersion,
      status: e.status as 'valid' | 'invalid',
      ...(e.reason !== null ? { reason: e.reason } : {}),
    }))
    return {
      recordId: row.id,
      generation: row.generation,
      ownerId: row.ownerId,
      sessionId: row.sessionId,
      title: revision ? body.title : row.title,
      category: revision ? body.category : row.category,
      body,
      status: row.status,
      evidenceStatus: row.evidenceStatus,
      currentRevision: row.currentRevision,
      revision: revision ? { version: revision.version, createdAt: revision.createdAt.toISOString() } : null,
      evidence,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  /**
   * #1084（RF-T08）发起会话删除的同事务钩子（SessionService.deleteSession 调用）：
   * - 该会话引用的已提交记录证据 → invalid + review_required（记录本身独立保留）；
   * - 未提交草稿（含 confirmed_pending_save）连同授权/展示一并关闭，迟到提交不能复活摘录；
   * - 先写 outbox 摘录副本再封锁，进程重启后仍能清理派生正文副本。
   */
  async clearInitiatingSession(tx: ReflectionTx, p: { ownerId: string; sessionId: string }): Promise<void> {
    const now = new Date()
    await tx.$executeRaw`
      INSERT INTO "reflection_cleanup_outbox"
        ("id", "ownerId", "sessionId", "messageId", "kind", "excerpt", "state", "attempts", "createdAt", "updatedAt")
      SELECT lower(hex(randomblob(16))), "ownerId", "sessionId", "messageId", 'source_cleanup', "excerpt", 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM "reflection_evidence"
      WHERE "ownerId" = ${p.ownerId} AND "sessionId" = ${p.sessionId} AND "status" = 'valid'`
    await tx.$executeRaw`
      INSERT INTO "reflection_cleanup_outbox"
        ("id", "ownerId", "sessionId", "messageId", "kind", "excerpt", "state", "attempts", "createdAt", "updatedAt")
      SELECT lower(hex(randomblob(16))), "ownerId", "sessionId", "messageId", 'source_cleanup', "excerpt", 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM "reflection_record_evidence"
      WHERE "ownerId" = ${p.ownerId} AND "sessionId" = ${p.sessionId} AND "status" = 'valid'`

    await tx.reflectionEvidence.updateMany({
      where: { ownerId: p.ownerId, sessionId: p.sessionId, status: { not: 'not_ready' } },
      data: { status: 'not_ready', reason: 'source_deleted' },
    })
    await tx.reflectionRecordEvidence.updateMany({
      where: { ownerId: p.ownerId, sessionId: p.sessionId, status: 'valid' },
      data: { status: 'invalid', reason: 'source_deleted' },
    })
    const affectedRecords = await tx.reflectionRecordEvidence.findMany({
      where: { ownerId: p.ownerId, sessionId: p.sessionId, status: 'invalid' },
      select: { recordId: true, recordVersion: true, record: { select: { currentRevision: true } } },
    })
    const recordIds = [...new Set(affectedRecords.filter(r => r.recordVersion === r.record.currentRevision).map((r) => r.recordId))]
    if (recordIds.length > 0) {
      await tx.reflectionRecord.updateMany({
        where: { ownerId: p.ownerId, id: { in: recordIds }, evidenceStatus: 'valid' },
        data: { evidenceStatus: 'review_required' },
      })
    }

    const drafts = await tx.reflectionDraft.findMany({
      where: {
        ownerId: p.ownerId,
        sessionId: p.sessionId,
        status: { in: ['preparing', 'pending', 'confirmed_pending_save'] },
      },
      select: { id: true, version: true },
    })
    const draftIds = drafts.map((d) => d.id)
    await tx.reflectionGrant.updateMany({
      where: {
        ownerId: p.ownerId,
        status: 'active',
        OR: [{ sessionId: p.sessionId }, ...(draftIds.length > 0 ? [{ draftId: { in: draftIds } }] : [])],
      },
      data: { status: 'revoked' },
    })
    if (draftIds.length > 0) {
      await tx.reflectionEvidence.updateMany({
        where: { ownerId: p.ownerId, draftId: { in: draftIds } },
        data: { status: 'not_ready', reason: 'source_deleted' },
      })
      await tx.reflectionPresentation.updateMany({
        where: { ownerId: p.ownerId, draftId: { in: draftIds } },
        data: { status: 'deleted', bodyJson: '{}', revokedAt: now },
      })
      await tx.reflectionDraft.updateMany({
        where: { ownerId: p.ownerId, id: { in: draftIds } },
        data: { status: 'cancelled', closedAt: now, contentJson: '{}', title: '' },
      })
      await tx.reflectionEvent.createMany({
        data: drafts.map((d) => ({
          ownerId: p.ownerId,
          objectId: d.id,
          action: 'draft_cancel',
          version: d.version,
          result: 'ok',
        })),
      })
    }
  }
}

function idempotencyKey(ownerId: string, confirmationMessageId: string): string {
  return `${ownerId}:${confirmationMessageId}`
}

// 撤授权 + 草稿回 pending + 旧展示撤销（过窗/rewind 共用；已提交记录不受影响）。
async function releaseGrant(
  tx: ReflectionTx,
  p: {
    ownerId: string
    grant: { id: string; draftId: string; draftVersion: number }
    now: Date
    status: 'revoked' | 'expired'
  },
): Promise<void> {
  await tx.reflectionGrant.updateMany({
    where: { id: p.grant.id, ownerId: p.ownerId, status: 'active' },
    data: { status: p.status },
  })
  await tx.reflectionDraft.updateMany({
    where: {
      id: p.grant.draftId,
      ownerId: p.ownerId,
      version: p.grant.draftVersion,
      status: 'confirmed_pending_save',
    },
    data: { status: 'pending' },
  })
  await tx.reflectionPresentation.updateMany({
    where: { ownerId: p.ownerId, draftId: p.grant.draftId, status: { in: ['active', 'acked'] } },
    data: { status: 'revoked', revokedAt: p.now },
  })
}

function parseCommitResult(raw: string): CommitResult {
  return JSON.parse(raw) as CommitResult
}

function grantOf(row: {
  id: string
  ownerId: string
  sessionId: string
  confirmationMessageId: string
  displayId: string
  draftId: string
  draftVersion: number
  bodyHash: string
  action: string
  ackSeq: number
  expiresAt: Date
  submissions: number
  status: string
}): GrantRecord {
  return {
    id: row.id,
    ownerId: row.ownerId,
    sessionId: row.sessionId,
    confirmationMessageId: row.confirmationMessageId,
    displayId: row.displayId,
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    bodyHash: row.bodyHash,
    action: row.action,
    ackSeq: row.ackSeq,
    expiresAt: row.expiresAt.toISOString(),
    submissions: row.submissions,
    status: row.status as GrantRecord['status'],
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
