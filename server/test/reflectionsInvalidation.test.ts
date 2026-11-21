// #1084（RF-T08）来源变化、删除与 rewind 的证据失效闭环验收：真实临时 SQLite + 真实会话入口
//（SessionService 删会话/rewind）+ 触发器 + outbox 重放。
//
// 覆盖父规格 I4/I7/I9 的可观察行为：源删除/内容变化/chat rewind 同步封锁证据并退出主动使用；
// files-only rewind 与普通追加不误伤；失效摘录在 search/read/present/模型解引用中不返回，
// 正文/原因中逐字复制的来源片段同样清理；删发起会话清未提交草稿与授权、已提交结论独立保留；
// outbox 重启重放且幂等。

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { createReflectionsRuntime, type ReflectionsRuntime } from '../src/reflections/runtime'
import { ReflectionCleanupService } from '../src/reflections/cleanup'
import type { ConfirmationClassification, ReflectionContext } from '../src/reflections/model'
import { SessionService, type SessionRunGateway } from '../src/sessions/service'
import { StreamHub } from '../src/events/hub'
import { serializeAttachments } from '../src/sessions/reducer'
import { seedUser } from './helpers'

const INIT_SQL = readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8')
const HISTORY_TRIGGERS_SQL = readFileSync(path.join(process.cwd(), 'prisma', 'history-triggers.sql'), 'utf8')
const REFLECTION_TRIGGERS_SQL = readFileSync(path.join(process.cwd(), 'prisma', 'reflection-triggers.sql'), 'utf8')

const SOURCE = '工具写文件后没有运行测试，导致回归反复出现。'
const EXCERPT = '写文件后没有运行测试'
const DRAFT = {
  operation: 'draft' as const,
  action: 'create' as const,
  category: 'verification' as const,
  title: '写后未验证',
  problem: `问题：${EXCERPT}，导致返工。`,
  causes: [{ text: `直接原因：${EXCERPT}。`, kind: 'fact' as const, evidence: [1] }],
  improvements: ['写文件后先运行聚焦测试'],
  scope: { labels: ['验证'], conditions: '涉及文件写入时', exclusions: '纯问答' },
}

const confirmClassifier = async (): Promise<ConfirmationClassification> => ({ decision: 'confirm' })

interface CommittedFixture {
  sessionId: string
  firstAssistantId: string
  sourceMessageId: string
  draftId: string
  displayId: string
  triggerMessageId: string
  recordId: string
}

describe('#1084 来源变化/删除/rewind 证据失效闭环（真实 SQLite）', () => {
  let dir: string
  let dbPath: string
  let prisma: PrismaClient
  let runtime: ReflectionsRuntime
  let cleanup: ReflectionCleanupService
  let ownerId: string
  let turn: number

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), `panel-1084-${process.pid}-`))
    dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(INIT_SQL)
    sqlite.exec(HISTORY_TRIGGERS_SQL)
    sqlite.exec(REFLECTION_TRIGGERS_SQL)
    sqlite.close()
    process.env.DATABASE_URL = `file:${dbPath}`
    process.env.NODE_ENV = 'test'
    prisma = createPrismaClient(`file:${dbPath}`)
    runtime = createReflectionsRuntime(prisma, { classifier: confirmClassifier })
    cleanup = new ReflectionCleanupService(prisma, { intervalMs: 60_000 })
    const user = await seedUser(prisma, 'rf-1084-owner', 'pw-rf-1084-secure')
    ownerId = user.id
    turn = 0
  }, 30_000)

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  afterEach(async () => {
    await prisma.reflectionCleanupOutbox.deleteMany({})
    await prisma.reflectionIdempotency.deleteMany({})
    await prisma.reflectionGrant.deleteMany({})
    await prisma.reflectionRecordEvidence.deleteMany({})
    await prisma.reflectionRevision.deleteMany({})
    await prisma.reflectionRecord.deleteMany({})
    await prisma.reflectionPresentation.deleteMany({})
    await prisma.reflectionEvidence.deleteMany({})
    await prisma.reflectionDraft.deleteMany({})
    await prisma.reflectionEvent.deleteMany({})
    await prisma.sessionMessage.deleteMany({ where: { session: { ownerId } } })
    await prisma.session.deleteMany({ where: { ownerId } })
    turn = 0
  })

  const leader = (sessionId: string, triggerMessageId?: string): ReflectionContext => ({
    ownerId,
    currentSessionId: sessionId,
    role: 'leader',
    // #1082：management 检索/读取需可信用户管理意图（本套件只验证失效语义）。
    managementIntent: true,
    ...(triggerMessageId ? { triggerMessageId } : {}),
  })

  function sessionGateway(): SessionRunGateway {
    return { stateOf: () => undefined } as unknown as SessionRunGateway
  }

  function sessionService(): SessionService {
    return new SessionService({
      prisma,
      hub: new StreamHub(),
      runService: sessionGateway(),
      dispatch: async () => {},
      reflections: { clearInitiatingSession: (tx, p) => runtime.store.clearInitiatingSession(tx, p) },
    })
  }

  async function createSession(title: string): Promise<string> {
    const session = await prisma.session.create({ data: { ownerId, containerId: `researcher-sandbox-1084-${Math.random().toString(36).slice(2)}`, title } })
    return session.id
  }

  async function createCheckpoint(sessionId: string, checkpointId: string, parentCheckpointId: string | null): Promise<void> {
    await prisma.checkpoint.create({
      data: {
        threadId: sessionId,
        checkpointNs: '',
        checkpointId,
        parentCheckpointId,
        type: 'json',
        blob: Buffer.from('{}'),
      },
    })
  }

  async function addMessage(p: {
    sessionId: string
    role: string
    content: string
    anchorCheckpointId?: string | null
    presentations?: unknown[]
    thinking?: string
  }): Promise<string> {
    turn += 1
    const row = await prisma.sessionMessage.create({
      data: {
        sessionId: p.sessionId,
        turn,
        role: p.role,
        content: p.content,
        anchorCheckpointId: p.anchorCheckpointId ?? null,
        attachmentsJson: serializeAttachments({
          ...(p.thinking !== undefined ? { thinking: p.thinking } : {}),
          ...(p.presentations !== undefined ? { presentations: p.presentations as never } : {}),
        }),
      },
    })
    return row.id
  }

  /** 建一条带 checkpoint 链的会话：first assistant 锚 cp1，source assistant 锚 cp2。 */
  async function seedSourceSession(title: string): Promise<{ sessionId: string; firstAssistantId: string; sourceMessageId: string }> {
    const sessionId = await createSession(title)
    await createCheckpoint(sessionId, 'cp-1', null)
    await createCheckpoint(sessionId, 'cp-2', 'cp-1')
    await addMessage({ sessionId, role: 'user', content: '第一轮请求' })
    const firstAssistantId = await addMessage({ sessionId, role: 'assistant', content: '第一轮回答', anchorCheckpointId: 'cp-1' })
    await addMessage({ sessionId, role: 'user', content: '第二轮请求' })
    const sourceMessageId = await addMessage({ sessionId, role: 'assistant', content: SOURCE, anchorCheckpointId: 'cp-2', thinking: `思考：${SOURCE}` })
    return { sessionId, firstAssistantId, sourceMessageId }
  }

  async function createPendingDraft(sessionId: string, messageId: string): Promise<{ draftId: string; version: number }> {
    const result = await runtime.service.execute(leader(sessionId), {
      ...DRAFT,
      evidence: [{ session_id: sessionId, message_id: messageId, region: 'content', excerpt: EXCERPT }],
    })
    expect(result.outcome).toBe('success')
    const draft = result.draft as { draft_id: string; version: number; status: string }
    expect(draft.status).toBe('pending')
    return { draftId: draft.draft_id, version: draft.version }
  }

  async function presentAndAck(sessionId: string, draftId: string, version: number): Promise<string> {
    const presented = await runtime.service.execute(leader(sessionId), { operation: 'present', draft_id: draftId, version })
    expect(presented.outcome).toBe('success')
    const presentation = presented.presentation as { displayId: string; bodyHash: string }
    const boundId = await addMessage({
      sessionId,
      role: 'assistant',
      content: '这是反思草稿。',
      presentations: [{
        displayId: presentation.displayId,
        draftId,
        version,
        bodyHash: presentation.bodyHash,
        status: 'pending',
        confirmable: true,
      }],
    })
    await runtime.store.bindInFlightEvidence({ ownerId, sessionId, runId: 'run-1084', messageId: boundId, displayIds: [presentation.displayId] })
    const acked = await runtime.service.ackDisplay(ownerId, presentation.displayId, {
      version,
      hash: presentation.bodyHash,
      messageId: boundId,
    })
    expect('seq' in acked).toBe(true)
    return presentation.displayId
  }

  async function grantFor(sessionId: string, draftId: string): Promise<string> {
    const triggerMessageId = await addMessage({ sessionId, role: 'user', content: '确认保存这条反思' })
    const outcome = await runtime.service.confirmTurn(leader(sessionId, triggerMessageId), confirmClassifier)
    expect(outcome.status).toBe('granted')
    expect((await prisma.reflectionDraft.findUniqueOrThrow({ where: { id: draftId } })).status).toBe('confirmed_pending_save')
    return triggerMessageId
  }

  async function committedFixture(title: string): Promise<CommittedFixture> {
    const { sessionId, firstAssistantId, sourceMessageId } = await seedSourceSession(title)
    const { draftId, version } = await createPendingDraft(sessionId, sourceMessageId)
    const displayId = await presentAndAck(sessionId, draftId, version)
    const triggerMessageId = await grantFor(sessionId, draftId)
    const committed = await runtime.service.execute(leader(sessionId, triggerMessageId), { operation: 'commit', draft_id: draftId, version })
    expect(committed.outcome).toBe('success')
    const record = committed.record as { record_id: string; evidence_status: string }
    expect(record.evidence_status).toBe('valid')
    return { sessionId, firstAssistantId, sourceMessageId, draftId, displayId, triggerMessageId, recordId: record.record_id }
  }

  it('普通追加不误伤；files-only rewind 不影响纯对话证据', async () => {
    const f = await committedFixture('普通追加')
    await addMessage({ sessionId: f.sessionId, role: 'assistant', content: '新增一轮普通回复' })
    expect((await prisma.reflectionRecord.findUniqueOrThrow({ where: { id: f.recordId } })).evidenceStatus).toBe('valid')
    expect(await prisma.reflectionCleanupOutbox.count()).toBe(0)
    expect((await prisma.reflectionEvidence.findFirstOrThrow({ where: { draftId: f.draftId } })).status).toBe('valid')

    const rewind = await sessionService().rewindSession({ id: ownerId, role: 'user' }, f.sessionId, { messageId: f.firstAssistantId, scope: 'files' })
    expect(rewind.scope).toBe('files')
    expect((await prisma.reflectionRecord.findUniqueOrThrow({ where: { id: f.recordId } })).evidenceStatus).toBe('valid')
    expect(await prisma.reflectionCleanupOutbox.count()).toBe(0)
    expect((await prisma.reflectionEvidence.findFirstOrThrow({ where: { draftId: f.draftId } })).status).toBe('valid')
  })

  it('chat rewind 同事务封锁证据：记录 review_required、授权撤销、展示失效、读门立即不交付正文', async () => {
    const f = await committedFixture('chat rewind')
    // 同会话另有一条未提交（pending + 已展示）草稿，用于验证展示/读门/解引用封锁。
    const pending = await createPendingDraft(f.sessionId, f.sourceMessageId)
    const pendingDisplayId = await presentAndAck(f.sessionId, pending.draftId, pending.version)

    const rewind = await sessionService().rewindSession({ id: ownerId, role: 'user' }, f.sessionId, { messageId: f.firstAssistantId, scope: 'chat' })
    expect(rewind.scope).toBe('chat')
    // 被放弃路线的源消息确实归档（封锁来自真实 rewind 入口，不是测试直接改状态）。
    expect((await prisma.sessionMessage.findUniqueOrThrow({ where: { id: f.sourceMessageId } })).archivedAt).not.toBeNull()

    const record = await prisma.reflectionRecord.findUniqueOrThrow({ where: { id: f.recordId } })
    expect(record).toMatchObject({ status: 'active', evidenceStatus: 'review_required' })
    const recordEvidence = await prisma.reflectionRecordEvidence.findMany({ where: { recordId: f.recordId } })
    expect(recordEvidence.length).toBeGreaterThan(0)
    expect(recordEvidence.every((e) => e.status === 'invalid' && e.reason === 'source_changed')).toBe(true)
    // 已提交草稿是历史产物保持 committed；未提交草稿回 preparing（需重新起草/复核）。
    expect((await prisma.reflectionDraft.findUniqueOrThrow({ where: { id: f.draftId } })).status).toBe('committed')
    expect((await prisma.reflectionDraft.findUniqueOrThrow({ where: { id: pending.draftId } })).status).toBe('preparing')
    expect((await prisma.reflectionGrant.findMany({ where: { draftId: pending.draftId } })).every((g) => g.status !== 'active')).toBe(true)
    expect((await prisma.reflectionPresentation.findUniqueOrThrow({ where: { displayId: pendingDisplayId } })).status).toBe('revoked')
    expect(await prisma.reflectionCleanupOutbox.count({ where: { state: 'pending' } })).toBeGreaterThan(0)

    // 读门在 outbox 清理前就封锁：experience 不返回，management 显示待复核且摘录/正文已占位。
    const context = leader(f.sessionId)
    const experience = await runtime.service.execute(context, { operation: 'search', purpose: 'experience' })
    expect(experience.records).toEqual([])
    const management = await runtime.service.execute(context, { operation: 'search', purpose: 'management' })
    const recordRow = (management.records as Array<{ record_id: string; evidence_status: string }>).find((r) => r.record_id === f.recordId)
    expect(recordRow).toMatchObject({ record_id: f.recordId, evidence_status: 'review_required' })

    const read = await runtime.service.execute(context, {
      operation: 'read',
      purpose: 'management',
      targets: [{ record_id: f.recordId }],
    })
    const detail = (read.records as Array<{ body_ref: string; version: number; evidence: Array<{ status: string; excerpt: string }> }>)[0]!
    expect(detail.body_ref).toContain('reflection_record:')
    expect(detail.evidence[0]).toMatchObject({ status: 'invalid' })
    expect(detail.evidence[0]!.excerpt).not.toContain(EXCERPT)
    const recordText = await runtime.service.recordBodyText(ownerId, f.recordId, detail.version)
    expect(recordText).not.toBeNull()
    expect(recordText!).not.toContain(EXCERPT)
    expect(recordText!).toContain('来源已失效')

    const display = await runtime.service.getDisplay(ownerId, pendingDisplayId)
    expect(display).toMatchObject({ invalidated: true, confirmable: false })
    expect(display!.body!.problem).not.toContain(EXCERPT)
    expect(display!.evidence[0]!.excerpt).not.toContain(EXCERPT)
    const dereferenced = await runtime.service.displayBodyText(ownerId, pendingDisplayId)
    expect(dereferenced).not.toBeNull()
    expect(dereferenced!).not.toContain(EXCERPT)
    const draftText = await runtime.service.draftBodyText(ownerId, pending.draftId, pending.version)
    expect(draftText).not.toBeNull()
    expect(draftText!).not.toContain(EXCERPT)

    // present 不再把封锁版本当可确认版本交付。
    const presented = await runtime.service.execute(context, { operation: 'present', draft_id: pending.draftId, version: pending.version })
    expect(presented.outcome).toBe('failure')
    expect(presented.error?.code).toBe('not_ready')
  })

  it('scope=all（对话+文件）同样触发证据封锁', async () => {
    const f = await committedFixture('scope all')
    const rewind = await sessionService().rewindSession({ id: ownerId, role: 'user' }, f.sessionId, { messageId: f.firstAssistantId, scope: 'all' })
    expect(rewind.scope).toBe('all')
    expect((await prisma.reflectionRecord.findUniqueOrThrow({ where: { id: f.recordId } })).evidenceStatus).toBe('review_required')
    expect((await prisma.reflectionRecordEvidence.findMany({ where: { recordId: f.recordId } })).every((e) => e.status === 'invalid')).toBe(true)
  })

  it('源会话失权（归档）同样把关联记录退出主动使用', async () => {
    const f = await committedFixture('会话归档')
    await prisma.session.update({ where: { id: f.sessionId }, data: { archivedAt: new Date() } })
    expect((await prisma.reflectionRecord.findUniqueOrThrow({ where: { id: f.recordId } })).evidenceStatus).toBe('review_required')
    const evidence = await prisma.reflectionRecordEvidence.findMany({ where: { recordId: f.recordId } })
    expect(evidence.every((e) => e.status === 'invalid' && e.reason === 'source_unavailable')).toBe(true)
    expect(await prisma.reflectionCleanupOutbox.count({ where: { state: 'pending' } })).toBeGreaterThan(0)
  })

  it('outbox 清理幂等且重启可重放：正文/原因/revision/展示副本的复制片段全部替换', async () => {
    const f = await committedFixture('outbox 清理')
    await sessionService().rewindSession({ id: ownerId, role: 'user' }, f.sessionId, { messageId: f.firstAssistantId, scope: 'chat' })

    expect(await cleanup.processPending()).toBeGreaterThan(0)

    const record = await prisma.reflectionRecord.findUniqueOrThrow({ where: { id: f.recordId } })
    expect(record.contentJson).not.toContain(EXCERPT)
    const revisions = await prisma.reflectionRevision.findMany({ where: { recordId: f.recordId } })
    expect(revisions.length).toBeGreaterThan(0)
    expect(revisions.every((r) => !r.bodyJson.includes(EXCERPT))).toBe(true)
    expect(revisions.every((r) => !r.evidenceJson.includes(EXCERPT))).toBe(true)
    const draft = await prisma.reflectionDraft.findUniqueOrThrow({ where: { id: f.draftId } })
    expect(draft.contentJson).not.toContain(EXCERPT)
    const presentation = await prisma.reflectionPresentation.findUniqueOrThrow({ where: { displayId: f.displayId } })
    expect(presentation.bodyJson).not.toContain(EXCERPT)
    const evidence = await prisma.reflectionEvidence.findFirstOrThrow({ where: { draftId: f.draftId } })
    expect(evidence.excerpt).not.toContain(EXCERPT)
    expect(await prisma.reflectionCleanupOutbox.count({ where: { state: 'pending' } })).toBe(0)
    // 清理完成后 outbox 不再保留来源摘录副本。
    const doneRows = await prisma.reflectionCleanupOutbox.findMany({ where: { state: 'done' } })
    expect(doneRows.length).toBeGreaterThan(0)
    expect(doneRows.every((row) => row.excerpt === '')).toBe(true)

    // 幂等二跑：没有 pending 行，且正文不再变化。
    const before = (await prisma.reflectionRecord.findUniqueOrThrow({ where: { id: f.recordId } })).contentJson
    expect(await cleanup.processPending()).toBe(0)
    expect((await prisma.reflectionRecord.findUniqueOrThrow({ where: { id: f.recordId } })).contentJson).toBe(before)

    // 重启重放：新实例 start 即扫，把残留 pending 清完；stop 干净收尾（父规格 RF20）。
    const g = await committedFixture('重启重放')
    await sessionService().rewindSession({ id: ownerId, role: 'user' }, g.sessionId, { messageId: g.firstAssistantId, scope: 'chat' })
    expect(await prisma.reflectionCleanupOutbox.count({ where: { state: 'pending' } })).toBeGreaterThan(0)
    const restarted = new ReflectionCleanupService(prisma, { intervalMs: 60_000 })
    restarted.start()
    const deadline = Date.now() + 5_000
    while (await prisma.reflectionCleanupOutbox.count({ where: { state: 'pending' } }) > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await restarted.stop()
    expect(await prisma.reflectionCleanupOutbox.count({ where: { state: 'pending' } })).toBe(0)
  })

  it('源消息内容变化与删除（中断/恢复残留路径）同样同事务封锁', async () => {
    const f = await committedFixture('内容变化')

    // 旧内容变化：UPDATE 触发器立即封锁。
    await prisma.sessionMessage.update({ where: { id: f.sourceMessageId }, data: { content: `${SOURCE}（已改写）` } })
    expect((await prisma.reflectionRecord.findUniqueOrThrow({ where: { id: f.recordId } })).evidenceStatus).toBe('review_required')
    expect((await prisma.reflectionRecordEvidence.findMany({ where: { recordId: f.recordId } })).every((e) => e.status === 'invalid')).toBe(true)

    // 直接 DELETE（recover 残留清理同机制）也必须封锁。
    const second = await committedFixture('删除来源')
    await prisma.sessionMessage.delete({ where: { id: second.sourceMessageId } })
    expect((await prisma.reflectionRecord.findUniqueOrThrow({ where: { id: second.recordId } })).evidenceStatus).toBe('review_required')
    const secondEvidence = await prisma.reflectionRecordEvidence.findMany({ where: { recordId: second.recordId } })
    expect(secondEvidence.every((e) => e.status === 'invalid' && e.reason === 'source_deleted')).toBe(true)
    expect(await prisma.reflectionCleanupOutbox.count({ where: { messageId: second.sourceMessageId, state: 'pending' } })).toBeGreaterThan(0)
  })

  it('删除发起会话：清未提交草稿（含已确认待保存）与授权；已提交结论独立保留并按来源失效', async () => {
    const f = await committedFixture('删会话保留结论')
    // 另建一条已确认待保存（grant 已签发、未提交）的草稿。
    const { sourceMessageId } = await seedSourceSession('删会话草稿')
    const pending = await createPendingDraft(f.sessionId, f.sourceMessageId)
    const pendingDisplay = await presentAndAck(f.sessionId, pending.draftId, pending.version)
    const pendingTrigger = await grantFor(f.sessionId, pending.draftId)
    const pendingBefore = await prisma.reflectionDraft.findUniqueOrThrow({ where: { id: pending.draftId } })
    expect(pendingBefore.status).toBe('confirmed_pending_save')
    expect((await prisma.reflectionGrant.findFirstOrThrow({ where: { confirmationMessageId: pendingTrigger } })).status).toBe('active')
    void sourceMessageId

    await sessionService().deleteSession({ id: ownerId, role: 'user' }, f.sessionId)

    // 未提交草稿/展示/证据随会话清理；迟到提交不能复活。
    expect(await prisma.reflectionDraft.findFirst({ where: { id: pending.draftId } })).toBeNull()
    expect(await prisma.reflectionPresentation.findFirst({ where: { displayId: pendingDisplay } })).toBeNull()
    expect((await prisma.reflectionGrant.findFirstOrThrow({ where: { confirmationMessageId: pendingTrigger } })).status).toBe('revoked')
    const late = await runtime.service.execute(leader(f.sessionId, pendingTrigger), { operation: 'commit', draft_id: pending.draftId, version: pending.version })
    expect(late.outcome).toBe('failure')

    // 已提交结论独立保留，但证据失效进入待复核。
    const record = await prisma.reflectionRecord.findUniqueOrThrow({ where: { id: f.recordId } })
    expect(record).toMatchObject({ status: 'active', evidenceStatus: 'review_required' })
    const recordEvidence = await prisma.reflectionRecordEvidence.findMany({ where: { recordId: f.recordId } })
    expect(recordEvidence.every((e) => e.status === 'invalid' && e.reason === 'source_deleted')).toBe(true)
    expect(await prisma.reflectionCleanupOutbox.count({ where: { state: 'pending' } })).toBeGreaterThan(0)
    // 清理后管理视图仍可查看待复核结论，且正文不含来源原文。
    await cleanup.processPending()
    const read = await runtime.service.execute(leader(f.sessionId), { operation: 'read', purpose: 'management', targets: [{ record_id: f.recordId }] })
    const detail = (read.records as Array<{ evidence_status: string; version: number; body_ref: string }>)[0]!
    expect(detail.evidence_status).toBe('review_required')
    expect(detail.body_ref).toContain('reflection_record:')
    const recordText = await runtime.service.recordBodyText(ownerId, f.recordId, detail.version)
    expect(recordText).not.toBeNull()
    expect(recordText!).not.toContain(EXCERPT)
  })

  it('多证据：失效来源退出主动使用，仍有效的来源在管理读取中保留', async () => {
    const sessionId = await createSession('多证据')
    const excerptA = '参数校验缺少边界检查'
    const excerptB = '写文件后没有运行测试'
    const messageA = await addMessage({ sessionId, role: 'assistant', content: `来源甲：${excerptA}。` })
    const messageB = await addMessage({ sessionId, role: 'assistant', content: `来源乙：${excerptB}。` })
    const created = await runtime.service.execute(leader(sessionId), {
      ...DRAFT,
      problem: `问题：${excerptA}，并且${excerptB}。`,
      causes: [{ text: `原因：${excerptA} / ${excerptB}。`, kind: 'fact', evidence: [1, 2] }],
      evidence: [
        { session_id: sessionId, message_id: messageA, region: 'content', excerpt: excerptA },
        { session_id: sessionId, message_id: messageB, region: 'content', excerpt: excerptB },
      ],
    })
    expect(created.outcome).toBe('success')
    const draftRef = created.draft as { draft_id: string; version: number; status: string }
    expect(draftRef.status).toBe('pending')
    await presentAndAck(sessionId, draftRef.draft_id, draftRef.version)
    const triggerId = await grantFor(sessionId, draftRef.draft_id)
    const committed = await runtime.service.execute(leader(sessionId, triggerId), { operation: 'commit', draft_id: draftRef.draft_id, version: draftRef.version })
    expect(committed.outcome).toBe('success')
    const recordId = (committed.record as { record_id: string }).record_id

    // 只删来源乙：记录待复核，但来源甲仍有效、仍可查看。
    await prisma.sessionMessage.delete({ where: { id: messageB } })
    const record = await prisma.reflectionRecord.findUniqueOrThrow({ where: { id: recordId } })
    expect(record.evidenceStatus).toBe('review_required')
    const read = await runtime.service.execute(leader(sessionId), { operation: 'read', purpose: 'management', targets: [{ record_id: recordId }] })
    const detail = (read.records as Array<{
      body_ref: string
      version: number
      evidence: Array<{ position: number; status: string; excerpt: string }>
    }>)[0]!
    expect(detail.body_ref).toContain('reflection_record:')
    expect(detail.evidence[0]).toMatchObject({ position: 1, status: 'valid' })
    expect(detail.evidence[0]!.excerpt).toContain(excerptA)
    expect(detail.evidence[1]).toMatchObject({ position: 2, status: 'invalid' })
    expect(detail.evidence[1]!.excerpt).not.toContain(excerptB)
    const recordText = await runtime.service.recordBodyText(ownerId, recordId, detail.version)
    expect(recordText).not.toBeNull()
    expect(recordText!).toContain(excerptA)
    expect(recordText!).not.toContain(excerptB)

    await cleanup.processPending()
    const stored = await prisma.reflectionRecord.findUniqueOrThrow({ where: { id: recordId } })
    expect(stored.contentJson).toContain(excerptA)
    expect(stored.contentJson).not.toContain(excerptB)
  })

  it('schema v22 从 revision.evidenceJson 幂等回填结构化证据（#1081 旧行）', async () => {
    const f = await committedFixture('回填')
    // 模拟 #1084 之前的已提交记录：只有 revision.evidenceJson，没有结构化证据行。
    await prisma.reflectionRecordEvidence.deleteMany({ where: { recordId: f.recordId } })
    expect(await prisma.reflectionRecordEvidence.count({ where: { recordId: f.recordId } })).toBe(0)

    const { runIncrementalSchema } = await import('../scripts/lib/incremental-schema.mjs')
    const db = new Database(dbPath)
    try {
      runIncrementalSchema(db)
      runIncrementalSchema(db) // 幂等二跑
    } finally {
      db.close()
    }
    const rows = await prisma.reflectionRecordEvidence.findMany({ where: { recordId: f.recordId }, orderBy: { position: 'asc' } })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toMatchObject({ sessionId: f.sessionId, messageId: f.sourceMessageId, status: 'valid' })
  })

  it('并发读取与来源失效：不交付「已撤销展示 + 未封锁正文」的混合快照（AC5）', async () => {
    const f = await committedFixture('并发')
    const pending = await createPendingDraft(f.sessionId, f.sourceMessageId)
    const displayId = await presentAndAck(f.sessionId, pending.draftId, pending.version)
    const reads = Array.from({ length: 12 }, () => runtime.service.getDisplay(ownerId, displayId))
    const [, ...settled] = await Promise.allSettled([
      sessionService().rewindSession({ id: ownerId, role: 'user' }, f.sessionId, { messageId: f.firstAssistantId, scope: 'chat' }),
      ...reads,
    ])
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue
      const shown = result.value as { status?: string; invalidated?: boolean; body?: { problem: string } | null } | null
      if (!shown) continue
      // 失效提交后读到的快照必须同时具备 revoked/invalidated；不得出现旧证据的未封锁正文。
      if (shown.status === 'revoked') expect(shown.invalidated).toBe(true)
      if (shown.invalidated) expect(shown.body?.problem ?? '').not.toContain(EXCERPT)
    }
    const after = await runtime.service.getDisplay(ownerId, displayId)
    expect(after).toMatchObject({ invalidated: true, confirmable: false })
    expect(after!.body!.problem).not.toContain(EXCERPT)
  })

  it('管理视图保留有效来源（补证草稿可见），不把旧记录当自证事实', async () => {
    const f = await committedFixture('补证草稿')
    await sessionService().rewindSession({ id: ownerId, role: 'user' }, f.sessionId, { messageId: f.firstAssistantId, scope: 'chat' })
    const recordEvidence = await prisma.reflectionRecordEvidence.findMany({ where: { recordId: f.recordId } })
    expect(recordEvidence.every((e) => e.status === 'invalid')).toBe(true)

    // 补证：引用一条仍然有效的来源消息重新起草（不直接恢复 valid，需后续确认/复核）。
    const validMessageId = await addMessage({ sessionId: f.sessionId, role: 'assistant', content: `补充证据：${SOURCE}，这次先运行了测试。` })
    const supplement = await runtime.service.execute(leader(f.sessionId), {
      ...DRAFT,
      title: '补证后的反思',
      evidence: [{ session_id: f.sessionId, message_id: validMessageId, region: 'content', excerpt: '这次先运行了测试' }],
    })
    expect(supplement.outcome).toBe('success')
    expect((supplement.draft as { status: string }).status).toBe('pending')
    // 原记录保持待复核，不被新草稿自证恢复。
    expect((await prisma.reflectionRecord.findUniqueOrThrow({ where: { id: f.recordId } })).evidenceStatus).toBe('review_required')
    // 经验检索仍不返回失效记录；管理读仍能看到有效来源（状态 invalid 的旧证据不冒充有效）。
    const experience = await runtime.service.execute(leader(f.sessionId), { operation: 'read', purpose: 'experience', targets: [{ record_id: f.recordId }] })
    const row = (experience.records as Array<{ status: string }>)[0]!
    expect(row.status).toBe('not_found')
    const management = await runtime.service.execute(leader(f.sessionId), { operation: 'read', purpose: 'management', targets: [{ record_id: f.recordId }] })
    const detail = (management.records as Array<{ evidence: Array<{ status: string; excerpt: string }>; evidence_status: string }>)[0]!
    expect(detail.evidence_status).toBe('review_required')
    expect(detail.evidence.some((e) => e.status === 'valid')).toBe(false)
  })
})
