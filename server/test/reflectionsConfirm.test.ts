// #1081（RF-T05）自然语言确认授权与幂等正式保存验收：真实临时 SQLite + 业务口 + 注入确认识别器。
//
// 覆盖父规格 I3/I5 的可观察行为：ack 早于确认消息才签 grant、含糊/否定/撤回不授权、伪造参数无效、
// 同一确认消息重试/并发只产生一条正式记录、授权过窗与提交次数上限、已提交独立保留。

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { createReflectionsRuntime, type ReflectionsRuntime } from '../src/reflections/runtime'
import type {
  ConfirmationClassification,
  ConfirmationDecision,
  ReflectionContext,
} from '../src/reflections/model'
import { serializeAttachments } from '../src/sessions/reducer'
import { seedUser } from './helpers'

const INIT_SQL = readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8')

const DRAFT = {
  operation: 'draft' as const,
  action: 'create' as const,
  category: 'tool_use' as const,
  title: '工具参数验证遗漏',
  problem: '修改文件后没有验证，导致问题反复。',
  causes: [{ text: '缺少写后验证步骤', kind: 'fact' as const, evidence: [1] }],
  improvements: ['遇到写文件后先运行聚焦测试再汇报'],
  scope: { labels: ['工具使用'], conditions: '涉及文件写入时', exclusions: '纯问答' },
}

function classifierReturning(decision: ConfirmationDecision, reason?: string) {
  return async (): Promise<ConfirmationClassification> => ({ decision, ...(reason ? { reason } : {}) })
}

describe('#1081 反思确认授权与正式保存（真实 SQLite）', () => {
  let dir: string
  let dbPath: string
  let prisma: PrismaClient
  let runtime: ReflectionsRuntime
  let ownerId: string
  let sessionId: string
  let turn: number

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), `panel-1081-${process.pid}-`))
    dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(INIT_SQL)
    sqlite.close()
    process.env.DATABASE_URL = `file:${dbPath}`
    process.env.NODE_ENV = 'test'
    prisma = createPrismaClient(`file:${dbPath}`)
    runtime = createReflectionsRuntime(prisma)
    const user = await seedUser(prisma, 'rf-confirm-owner', 'pw-rf-confirm-secure')
    ownerId = user.id
    const session = await prisma.session.create({ data: { ownerId, containerId: 'researcher-sandbox-rfc', title: '确认会话' } })
    sessionId = session.id
    turn = 100
  }, 30_000)

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  afterEach(async () => {
    await prisma.reflectionIdempotency.deleteMany({})
    await prisma.reflectionGrant.deleteMany({})
    await prisma.reflectionRevision.deleteMany({})
    await prisma.reflectionRecord.deleteMany({})
    await prisma.reflectionPresentation.deleteMany({})
    await prisma.reflectionEvidence.deleteMany({})
    await prisma.reflectionDraft.deleteMany({})
    await prisma.reflectionEvent.deleteMany({})
    await prisma.sessionMessage.deleteMany({ where: { sessionId } })
    await prisma.session.deleteMany({ where: { ownerId, id: { not: sessionId } } })
    turn = 100
  })

  const leader = (triggerMessageId?: string): ReflectionContext => ({
    ownerId,
    currentSessionId: sessionId,
    role: 'leader',
    ...(triggerMessageId ? { triggerMessageId } : {}),
  })

  async function seedAssistant(content: string): Promise<{ id: string }> {
    turn += 1
    const row = await prisma.sessionMessage.create({
      data: { sessionId, turn, role: 'assistant', content, attachmentsJson: serializeAttachments({ thinking: '思考' }) },
    })
    return { id: row.id }
  }

  async function seedUserMessage(content: string): Promise<{ id: string }> {
    turn += 1
    const row = await prisma.sessionMessage.create({
      data: { sessionId, turn, role: 'user', content, attachmentsJson: serializeAttachments({}) },
    })
    return { id: row.id }
  }

  async function bindAndAck(displayId: string, version: number, bodyHash: string): Promise<string> {
    turn += 1
    const bound = await prisma.sessionMessage.create({
      data: {
        sessionId,
        turn,
        role: 'assistant',
        content: '这是反思草稿。',
        attachmentsJson: serializeAttachments({
          presentations: [{ displayId, draftId: (await prisma.reflectionPresentation.findUniqueOrThrow({ where: { displayId } })).draftId, version, bodyHash, status: 'pending' as never, confirmable: true }],
        }),
      },
    })
    await runtime.store.bindInFlightEvidence({ ownerId, sessionId, runId: 'run-unused', messageId: bound.id, displayIds: [displayId] })
    const acked = await runtime.service.ackDisplay(ownerId, displayId, { version, hash: bodyHash, messageId: bound.id })
    expect('seq' in acked).toBe(true)
    return bound.id
  }

  async function seedPresentation(opts: { ack?: boolean } = {}): Promise<{
    draftId: string
    version: number
    displayId: string
    bodyHash: string
    boundMessageId: string
  }> {
    const source = await seedAssistant('写文件后没有运行测试，导致回归。')
    const created = await runtime.service.execute(leader(), {
      ...DRAFT,
      evidence: [{ session_id: sessionId, message_id: source.id, region: 'content', excerpt: '写文件后没有运行测试，导致回归。' }],
    })
    expect(created.outcome).toBe('success')
    const draft = created.draft as { draft_id: string; version: number }
    const presented = await runtime.service.execute(leader(), { operation: 'present', draft_id: draft.draft_id, version: draft.version })
    expect(presented.outcome).toBe('success')
    const presentation = presented.presentation as { displayId: string; bodyHash: string }

    if (opts.ack === false) {
      turn += 1
      const bound = await prisma.sessionMessage.create({
        data: {
          sessionId,
          turn,
          role: 'assistant',
          content: '这是反思草稿。',
          attachmentsJson: serializeAttachments({
            presentations: [{
              displayId: presentation.displayId,
              draftId: draft.draft_id,
              version: draft.version,
              bodyHash: presentation.bodyHash,
              status: 'pending' as never,
              confirmable: true,
            }],
          }),
        },
      })
      await runtime.store.bindInFlightEvidence({ ownerId, sessionId, runId: 'run-unused', messageId: bound.id, displayIds: [presentation.displayId] })
      return { draftId: draft.draft_id, version: draft.version, displayId: presentation.displayId, bodyHash: presentation.bodyHash, boundMessageId: bound.id }
    }
    const boundMessageId = await bindAndAck(presentation.displayId, draft.version, presentation.bodyHash)
    return { draftId: draft.draft_id, version: draft.version, displayId: presentation.displayId, bodyHash: presentation.bodyHash, boundMessageId }
  }


  it('已 ack 的展示后用户自然语言确认：签发 grant、草稿进入 confirmed_pending_save', async () => {
    const display = await seedPresentation()
    const confirm = await seedUserMessage('好，就按这个保存吧')
    const outcome = await runtime.service.confirmTurn(leader(confirm.id), classifierReturning('confirm'))
    expect(outcome.status).toBe('granted')
    expect(outcome.displayId).toBe(display.displayId)
    expect(outcome.draftId).toBe(display.draftId)

    const grant = await prisma.reflectionGrant.findFirst({ where: { ownerId } })
    expect(grant).not.toBeNull()
    expect(grant?.confirmationMessageId).toBe(confirm.id)
    expect(grant?.draftVersion).toBe(display.version)
    expect(grant?.status).toBe('active')
    expect(grant?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000)
    const draft = await prisma.reflectionDraft.findUnique({ where: { id: display.draftId } })
    expect(draft?.status).toBe('confirmed_pending_save')
  })

  it('同一版本重新展示并再次 ack 后确认：只认最新展示，不产生多候选歧义', async () => {
    const display = await seedPresentation()
    const represented = await runtime.service.execute(leader(), { operation: 'present', draft_id: display.draftId, version: display.version })
    expect(represented.outcome, JSON.stringify(represented)).toBe('success')
    const rep = represented.presentation as { displayId: string; bodyHash: string }
    await bindAndAck(rep.displayId, display.version, rep.bodyHash)
    const message = await seedUserMessage('好，保存最新展示的这一版')
    const outcome = await runtime.service.confirmTurn(leader(message.id), classifierReturning('confirm'))
    expect(outcome.status, JSON.stringify(outcome)).toBe('granted')
    expect(await prisma.reflectionGrant.count({ where: { ownerId } })).toBe(1)
  })

  it('commit 只凭可信上下文消费 grant：一事务产生记录/revision；同一确认消息重试返回同一记录', async () => {
    const display = await seedPresentation()
    const confirm = await seedUserMessage('确认，保存这一版')
    expect((await runtime.service.confirmTurn(leader(confirm.id), classifierReturning('confirm'))).status).toBe('granted')

    const committed = await runtime.service.execute(leader(confirm.id), {
      operation: 'commit',
      draft_id: display.draftId,
      version: display.version,
    })
    expect(committed.outcome, JSON.stringify(committed)).toBe('success')
    const record = committed.record as { record_id: string; revision: number; title: string; status: string }
    expect(record.revision).toBe(1)
    expect(record.status).toBe('active')
    expect(record.title).toBe(DRAFT.title)

    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(1)
    const revisions = await prisma.reflectionRevision.findMany({ where: { recordId: record.record_id } })
    expect(revisions).toHaveLength(1)
    expect(JSON.parse(revisions[0]!.bodyJson).title).toBe(DRAFT.title)
    const grant = await prisma.reflectionGrant.findFirst({ where: { confirmationMessageId: confirm.id } })
    expect(grant?.status).toBe('consumed')
    const draft = await prisma.reflectionDraft.findUnique({ where: { id: display.draftId } })
    expect(draft?.status).toBe('committed')

    // 同一确认消息重试（即便 grant 已消费）只返回原结果，不重复落记录。
    const retry = await runtime.service.execute(leader(confirm.id), {
      operation: 'commit',
      draft_id: display.draftId,
      version: display.version,
    })
    expect(retry.outcome).toBe('success')
    expect((retry.record as { record_id: string }).record_id).toBe(record.record_id)
    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(1)
    expect(await prisma.reflectionRevision.count({ where: { recordId: record.record_id } })).toBe(1)
  })

  it('成功后即便确认消息被归档/过窗，重复提交仍返回已提交结果', async () => {
    const display = await seedPresentation()
    const message = await seedUserMessage('确认保存')
    expect((await runtime.service.confirmTurn(leader(message.id), classifierReturning('confirm'))).status).toBe('granted')
    const first = await runtime.service.execute(leader(message.id), {
      operation: 'commit',
      draft_id: display.draftId,
      version: display.version,
    })
    expect(first.outcome).toBe('success')
    await prisma.sessionMessage.update({ where: { id: message.id }, data: { archivedAt: new Date() } })
    const retry = await runtime.service.execute(leader(message.id), {
      operation: 'commit',
      draft_id: display.draftId,
      version: display.version,
    })
    expect(retry.outcome).toBe('success')
    expect((retry.record as { record_id: string }).record_id).toBe((first.record as { record_id: string }).record_id)
    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(1)
  })

  it('RF08 commit成功结果未知，真实新进程重试只返回原记录', async () => {
    const display = await seedPresentation()
    const message = await seedUserMessage('确认保存')
    await runtime.service.confirmTurn(leader(message.id), classifierReturning('confirm'))
    const request = { operation: 'commit', draft_id: display.draftId, version: display.version }
    const committed = await runtime.service.execute(leader(message.id), request)
    expect(committed.outcome).toBe('success')
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'test/fixtures/reflection-recover.mts', `file:${dbPath}`, JSON.stringify(leader(message.id)), JSON.stringify(request)], { encoding: 'utf8' })
    const recovered = JSON.parse(output.trim())
    expect(recovered.outcome).toBe('success')
    expect(recovered.record).toEqual(committed.record)
    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(1)
  })

  it('#1087 分类失败后重启不重新批准，原消息停止增强', async () => {
    await seedPresentation()
    const message = await seedUserMessage('确认保存')
    expect((await runtime.service.confirmTurn(leader(message.id), async () => { throw new Error('故障') })).status).toBe('classifier_unavailable')
    const restarted = createReflectionsRuntime(prisma)
    try {
      expect((await restarted.service.confirmTurn(leader(message.id), classifierReturning('confirm'))).status).toBe('skipped')
      expect(await prisma.reflectionGrant.count({ where: { confirmationMessageId: message.id } })).toBe(0)
    } finally { await restarted.dispose() }
  })

  it('#1087 重启重放确认不重新分类', async () => {
    await seedPresentation()
    const message = await seedUserMessage('确认保存')
    const first = await runtime.service.confirmTurn(leader(message.id), classifierReturning('confirm'))
    expect(first.status).toBe('granted')
    const restarted = createReflectionsRuntime(prisma)
    try {
      expect(await restarted.service.confirmTurn(leader(message.id), async () => { throw new Error('不得重新分类') })).toEqual(first)
    } finally { restarted.dispose() }
  })

  it.each([
    ['reject', '不要保存，先别存'],
    ['revise', '整体可以，但把范围改小一点再保存'],
    ['ambiguous', '嗯……你看着办吧'],
    ['unrelated', '帮我看看另一个文件'],
  ] as const)('分类为 %s 不签发授权，commit 仍要求确认', async (decision, text) => {
    const display = await seedPresentation()
    const message = await seedUserMessage(text)
    const outcome = await runtime.service.confirmTurn(leader(message.id), classifierReturning(decision))
    expect(outcome.status).toBe(decision === 'reject' ? 'rejected' : decision)
    expect(await prisma.reflectionGrant.count({ where: { ownerId } })).toBe(0)
    const commit = await runtime.service.execute(leader(message.id), {
      operation: 'commit',
      draft_id: display.draftId,
      version: display.version,
    })
    expect(commit.outcome).toBe('failure')
    expect(commit.error?.code).toBe('confirmation_required')
    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(0)
  })

  it('多个候选展示无明确目标 → ambiguous 且不调用分类器', async () => {
    await seedPresentation()
    await seedPresentation()
    const message = await seedUserMessage('保存吧')
    let calls = 0
    const outcome = await runtime.service.confirmTurn(leader(message.id), async () => {
      calls += 1
      return { decision: 'confirm' }
    })
    expect(outcome.status).toBe('ambiguous')
    expect(calls).toBe(0)
    expect(await prisma.reflectionGrant.count({ where: { ownerId } })).toBe(0)
  })

  it('确认消息早于 ack 入列 → 不签发授权（不能事后补 ack 追认）', async () => {
    const pending = await seedPresentation({ ack: false })
    const message = await seedUserMessage('这个挺好，保存吧')
    const acked = await runtime.service.ackDisplay(ownerId, pending.displayId, {
      version: pending.version,
      hash: pending.bodyHash,
      messageId: pending.boundMessageId,
    })
    expect('seq' in acked).toBe(true)
    const outcome = await runtime.service.confirmTurn(leader(message.id), classifierReturning('confirm'))
    expect(outcome.status).toBe('skipped')
    expect(await prisma.reflectionGrant.count({ where: { ownerId } })).toBe(0)
  })

  it('模型伪造 approved/grantToken 等字段被 schema 拒绝', async () => {
    const display = await seedPresentation()
    const message = await seedUserMessage('保存')
    expect((await runtime.service.confirmTurn(leader(message.id), classifierReturning('confirm'))).status).toBe('granted')
    const forged = await runtime.service.execute(leader(message.id), {
      operation: 'commit',
      draft_id: display.draftId,
      version: display.version,
      approved: true,
      grant_token: 'fake',
    })
    expect(forged.outcome).toBe('failure')
    expect(forged.error?.code).toBe('invalid_parameters')
    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(0)
  })

  it('授权只属于签发它的确认消息：后续用户消息不能继承', async () => {
    const display = await seedPresentation()
    const first = await seedUserMessage('保存吧')
    expect((await runtime.service.confirmTurn(leader(first.id), classifierReturning('confirm'))).status).toBe('granted')
    const second = await seedUserMessage('好的')
    const commit = await runtime.service.execute(leader(second.id), {
      operation: 'commit',
      draft_id: display.draftId,
      version: display.version,
    })
    expect(commit.error?.code).toBe('confirmation_required')
    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(0)
  })

  it('同一确认消息并发提交只产生一条正式结果', async () => {
    const display = await seedPresentation()
    const message = await seedUserMessage('确认保存')
    expect((await runtime.service.confirmTurn(leader(message.id), classifierReturning('confirm'))).status).toBe('granted')
    const [a, b] = await Promise.all([
      runtime.service.execute(leader(message.id), { operation: 'commit', draft_id: display.draftId, version: display.version }),
      runtime.service.execute(leader(message.id), { operation: 'commit', draft_id: display.draftId, version: display.version }),
    ])
    expect(a.outcome, JSON.stringify(a)).toBe('success')
    expect(b.outcome, JSON.stringify(b)).toBe('success')
    expect((a.record as { record_id: string }).record_id).toBe((b.record as { record_id: string }).record_id)
    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(1)
    expect(await prisma.reflectionRevision.count({ where: { recordId: (a.record as { record_id: string }).record_id } })).toBe(1)
  })

  it('授权过窗：撤授权、草稿回 pending、旧展示失效；重新展示并再次确认后才能保存', async () => {
    let now = Date.now()
    const timed = createReflectionsRuntime(prisma, { clock: () => now })
    const display = await seedPresentation()
    const first = await seedUserMessage('保存这一版')
    expect((await timed.service.confirmTurn(leader(first.id), classifierReturning('confirm'))).status).toBe('granted')

    now += 10 * 60_000 + 1
    const expired = await timed.service.execute(leader(first.id), {
      operation: 'commit',
      draft_id: display.draftId,
      version: display.version,
    })
    expect(expired.error?.code).toBe('expired')
    expect((await prisma.reflectionGrant.findFirst({ where: { confirmationMessageId: first.id } }))?.status).toBe('expired')
    expect((await prisma.reflectionDraft.findUnique({ where: { id: display.draftId } }))?.status).toBe('pending')
    expect((await prisma.reflectionPresentation.findUnique({ where: { displayId: display.displayId } }))?.status).toBe('revoked')
    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(0)

    // 过窗重展示 + 新确认消息 → 新授权可保存。
    const represented = await timed.service.execute(leader(), { operation: 'present', draft_id: display.draftId, version: display.version })
    expect(represented.outcome).toBe('success')
    const rep = represented.presentation as { displayId: string; bodyHash: string }
    const boundMessageId = await bindAndAck(rep.displayId, display.version, rep.bodyHash)
    expect(boundMessageId).toBeTruthy()
    const second = await seedUserMessage('好的，确认保存')
    expect((await timed.service.confirmTurn(leader(second.id), classifierReturning('confirm'))).status).toBe('granted')
    const saved = await timed.service.execute(leader(second.id), {
      operation: 'commit',
      draft_id: display.draftId,
      version: display.version,
    })
    expect(saved.outcome, JSON.stringify(saved)).toBe('success')
    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(1)
  })

  it('授权期内最多提交 3 次：冲突尝试也计数，第 4 次明确 limit', async () => {
    const display = await seedPresentation()
    const message = await seedUserMessage('保存')
    expect((await runtime.service.confirmTurn(leader(message.id), classifierReturning('confirm'))).status).toBe('granted')
    // 人为制造草稿状态漂移：每次提交都失败但计数提交。
    for (let i = 0; i < 3; i++) {
      await prisma.reflectionDraft.update({ where: { id: display.draftId }, data: { status: 'pending' } })
      const failed = await runtime.service.execute(leader(message.id), {
        operation: 'commit',
        draft_id: display.draftId,
        version: display.version,
      })
      expect(failed.error?.code).toBe('conflict')
    }
    await prisma.reflectionDraft.update({ where: { id: display.draftId }, data: { status: 'pending' } })
    const fourth = await runtime.service.execute(leader(message.id), {
      operation: 'commit',
      draft_id: display.draftId,
      version: display.version,
    })
    expect(fourth.error?.code).toBe('limit')
    const grant = await prisma.reflectionGrant.findFirst({ where: { confirmationMessageId: message.id } })
    expect(grant?.submissions).toBe(3)
    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(0)
  })

  it('撤回未提交的确认：撤销 grant、清理草稿副本，原确认不能再提交', async () => {
    const display = await seedPresentation()
    const first = await seedUserMessage('保存这一版')
    expect((await runtime.service.confirmTurn(leader(first.id), classifierReturning('confirm'))).status).toBe('granted')
    const withdraw = await seedUserMessage('等等，先别保存了')
    const outcome = await runtime.service.confirmTurn(leader(withdraw.id), classifierReturning('withdraw'))
    expect(outcome.status).toBe('withdrawn')
    expect((await prisma.reflectionGrant.findFirst({ where: { confirmationMessageId: first.id } }))?.status).toBe('revoked')
    expect((await prisma.reflectionDraft.findUnique({ where: { id: display.draftId } }))?.status).toBe('cancelled')
    const commit = await runtime.service.execute(leader(first.id), {
      operation: 'commit',
      draft_id: display.draftId,
      version: display.version,
    })
    expect(commit.outcome).toBe('failure')
    expect(commit.error?.code).toBe('revoked')
    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(0)
  })

  it('cancel 关闭待保存草稿时同时撤销未消费授权', async () => {
    const display = await seedPresentation()
    const message = await seedUserMessage('保存')
    expect((await runtime.service.confirmTurn(leader(message.id), classifierReturning('confirm'))).status).toBe('granted')
    const cancelled = await runtime.service.execute(leader(), { operation: 'cancel', draft_id: display.draftId })
    expect(cancelled.outcome).toBe('success')
    expect((await prisma.reflectionGrant.findFirst({ where: { confirmationMessageId: message.id } }))?.status).toBe('revoked')
    const commit = await runtime.service.execute(leader(message.id), {
      operation: 'commit',
      draft_id: display.draftId,
      version: display.version,
    })
    expect(commit.outcome).toBe('failure')
    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(0)
  })

  it('正式提交事件写失败 → 整笔回滚；随后正常重试可保存', async () => {
    const display = await seedPresentation()
    const message = await seedUserMessage('确认保存')
    expect((await runtime.service.confirmTurn(leader(message.id), classifierReturning('confirm'))).status).toBe('granted')
    const failing = createReflectionsRuntime(prisma, {}, { failEventWrite: (action) => action === 'record_commit' })
    const failed = await failing.service.execute(leader(message.id), {
      operation: 'commit',
      draft_id: display.draftId,
      version: display.version,
    })
    expect(failed.outcome).toBe('failure')
    expect(failed.error?.code).toBe('system_error')
    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(0)
    expect(await prisma.reflectionRevision.count({})).toBe(0)
    expect(await prisma.reflectionIdempotency.count({})).toBe(0)
    expect((await prisma.reflectionGrant.findFirst({ where: { confirmationMessageId: message.id } }))?.status).toBe('active')
    expect((await prisma.reflectionDraft.findUnique({ where: { id: display.draftId } }))?.status).toBe('confirmed_pending_save')

    const retried = await runtime.service.execute(leader(message.id), {
      operation: 'commit',
      draft_id: display.draftId,
      version: display.version,
    })
    expect(retried.outcome, JSON.stringify(retried)).toBe('success')
    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(1)
  })

  it('确认识别故障：两次尝试后无授权，原任务可继续', async () => {
    const display = await seedPresentation()
    const message = await seedUserMessage('保存')
    let attempts = 0
    const outcome = await runtime.service.confirmTurn(leader(message.id), async () => {
      attempts += 1
      throw new Error('classifier timeout')
    })
    expect(outcome.status).toBe('classifier_unavailable')
    expect(attempts).toBe(2)
    expect(await prisma.reflectionGrant.count({ where: { ownerId } })).toBe(0)
    const commit = await runtime.service.execute(leader(message.id), {
      operation: 'commit',
      draft_id: display.draftId,
      version: display.version,
    })
    expect(commit.error?.code).toBe('confirmation_required')
  })

  it('识别超时：单次超时也计入两次上限，超时后无授权', async () => {
    await seedPresentation()
    const message = await seedUserMessage('保存')
    const timed = createReflectionsRuntime(prisma, { classificationTimeoutMs: 10 })
    let attempts = 0
    const outcome = await timed.service.confirmTurn(leader(message.id), async () => {
      attempts += 1
      // 故意忽略 abort signal，验证业务口自身的有界等待。
      await new Promise((resolve) => setTimeout(resolve, 50))
      return { decision: 'confirm' }
    })
    expect(outcome.status).toBe('classifier_unavailable')
    expect(attempts).toBe(2)
    expect(await prisma.reflectionGrant.count({ where: { ownerId } })).toBe(0)
  })

  it('识别输入只用真实确认消息原文、服务端动作快照与至多前 2 条用户消息', async () => {
    const display = await seedPresentation()
    await seedUserMessage('更早的一句话')
    await seedUserMessage('稍早的一句话')
    await seedUserMessage('最近的一句话')
    const confirm = await seedUserMessage('就这个版本，确认保存')
    let captured: import('../src/reflections/model').ConfirmationClassifierInput | undefined
    await runtime.service.confirmTurn(leader(confirm.id), async (input) => {
      captured = input
      return { decision: 'unrelated' }
    })
    expect(captured).toBeDefined()
    expect(captured!.userText).toBe('就这个版本，确认保存')
    expect(captured!.previousUserMessages).toEqual(['稍早的一句话', '最近的一句话'])
    expect(captured!.action.displayId).toBe(display.displayId)
    expect(captured!.action.version).toBe(display.version)
  })

  it('跨会话：在新会话调出旧草稿、完整展示并 ack 后由新会话用户消息确认保存', async () => {
    const display = await seedPresentation()
    const other = await prisma.session.create({ data: { ownerId, containerId: 'researcher-sandbox-rfc2', title: '另一个会话' } })
    const ctx = { ownerId, currentSessionId: other.id, role: 'leader' as const }
    const presented = await runtime.service.execute(ctx, { operation: 'present', draft_id: display.draftId, version: display.version })
    expect(presented.outcome, JSON.stringify(presented)).toBe('success')
    const rep = presented.presentation as { displayId: string; bodyHash: string }

    const bound = await prisma.sessionMessage.create({
      data: {
        sessionId: other.id,
        turn: 1,
        role: 'assistant',
        content: '重新展示反思草稿。',
        attachmentsJson: serializeAttachments({ presentations: [{ displayId: rep.displayId, draftId: display.draftId, version: display.version, bodyHash: rep.bodyHash, status: 'pending' as never, confirmable: true }] }),
      },
    })
    await runtime.store.bindInFlightEvidence({ ownerId, sessionId: other.id, runId: 'run-unused', messageId: bound.id, displayIds: [rep.displayId] })
    expect('seq' in await runtime.service.ackDisplay(ownerId, rep.displayId, { version: display.version, hash: rep.bodyHash, messageId: bound.id })).toBe(true)

    const confirm = await prisma.sessionMessage.create({ data: { sessionId: other.id, turn: 2, role: 'user', content: '好，保存这个版本' } })
    const outcome = await runtime.service.confirmTurn({ ...ctx, triggerMessageId: confirm.id }, classifierReturning('confirm'))
    expect(outcome.status, JSON.stringify(outcome)).toBe('granted')
    const committed = await runtime.service.execute({ ...ctx, triggerMessageId: confirm.id }, {
      operation: 'commit',
      draft_id: display.draftId,
      version: display.version,
    })
    expect(committed.outcome, JSON.stringify(committed)).toBe('success')
    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(1)
  })

  it('确认后草稿被实质修订：旧授权撤销、旧版本不能再保存', async () => {
    const display = await seedPresentation()
    const message = await seedUserMessage('保存')
    expect((await runtime.service.confirmTurn(leader(message.id), classifierReturning('confirm'))).status).toBe('granted')
    const source = await seedAssistant('修订后的证据正文')
    const revised = await runtime.service.execute(leader(), {
      ...DRAFT,
      action: 'revise',
      draft_id: display.draftId,
      base_version: display.version,
      title: '修订后的标题',
      evidence: [{ session_id: sessionId, message_id: source.id, region: 'content', excerpt: '修订后的证据正文' }],
    })
    expect(revised.outcome, JSON.stringify(revised)).toBe('success')
    expect((await prisma.reflectionGrant.findFirst({ where: { confirmationMessageId: message.id } }))?.status).toBe('revoked')
    const commit = await runtime.service.execute(leader(message.id), {
      operation: 'commit',
      draft_id: display.draftId,
      version: display.version,
    })
    expect(commit.outcome).toBe('failure')
    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(0)
  })

  it('提交后再撤回不会删除已保存记录（独立保留）', async () => {
    const display = await seedPresentation()
    const message = await seedUserMessage('确认保存')
    expect((await runtime.service.confirmTurn(leader(message.id), classifierReturning('confirm'))).status).toBe('granted')
    const saved = await runtime.service.execute(leader(message.id), {
      operation: 'commit',
      draft_id: display.draftId,
      version: display.version,
    })
    expect(saved.outcome).toBe('success')
    const withdraw = await seedUserMessage('算了，撤回刚才的确认')
    const outcome = await runtime.service.confirmTurn(leader(withdraw.id), classifierReturning('withdraw'))
    // 已提交后无待保存候选：撤回不触碰正式记录。
    expect(['skipped', 'already_committed']).toContain(outcome.status)
    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(1)
  })

  it('rewind 归档确认消息或展示绑定行：未提交授权撤销，不能保存', async () => {
    const first = await seedPresentation()
    const firstConfirm = await seedUserMessage('保存')
    expect((await runtime.service.confirmTurn(leader(firstConfirm.id), classifierReturning('confirm'))).status).toBe('granted')
    await prisma.sessionMessage.update({ where: { id: firstConfirm.id }, data: { archivedAt: new Date() } })
    const commitAfterMessageRewind = await runtime.service.execute(leader(firstConfirm.id), {
      operation: 'commit',
      draft_id: first.draftId,
      version: first.version,
    })
    expect(commitAfterMessageRewind.error?.code).toBe('revoked')
    expect((await prisma.reflectionGrant.findFirst({ where: { confirmationMessageId: firstConfirm.id } }))?.status).toBe('revoked')

    const second = await seedPresentation()
    const secondConfirm = await seedUserMessage('这版可以保存')
    expect((await runtime.service.confirmTurn(leader(secondConfirm.id), classifierReturning('confirm'))).status).toBe('granted')
    await prisma.sessionMessage.update({ where: { id: second.boundMessageId }, data: { archivedAt: new Date() } })
    const commitAfterDisplayRewind = await runtime.service.execute(leader(secondConfirm.id), {
      operation: 'commit',
      draft_id: second.draftId,
      version: second.version,
    })
    expect(commitAfterDisplayRewind.error?.code).toBe('revoked')
    expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(0)
  })




})
