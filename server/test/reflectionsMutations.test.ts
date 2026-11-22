// #1081（RF-T05）自然语言确认授权与幂等正式保存验收：真实临时 SQLite + 业务口 + 注入确认识别器。
//
// 覆盖父规格 I3/I5 的可观察行为：ack 早于确认消息才签 grant、含糊/否定/撤回不授权、伪造参数无效、
// 同一确认消息重试/并发只产生一条正式记录、授权过窗与提交次数上限、已提交独立保留。

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { randomUUID } from 'node:crypto'
import { PrismaCheckpointSaver } from '../src/runner/persistence/prismaCheckpointSaver'
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { ReflectionCleanupService } from '../src/reflections/cleanup'
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

describe('#1083 完整确认路径的正式记录变更', () => {
  let dir: string
  let prisma: PrismaClient
  let runtime: ReflectionsRuntime
  let ownerId: string
  let sessionId: string
  let turn: number

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), `panel-1081-${process.pid}-`))
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(INIT_SQL)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'reflection-triggers.sql'), 'utf8'))
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'reflection-owner-trigger.sql'), 'utf8'))
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


  async function newDraft(extra: Record<string, unknown> = {}) {
    const source = await seedAssistant('写文件后没有运行测试，导致回归。')
    const result = await runtime.service.execute(leader(), {
      ...DRAFT,
      evidence: [{ message_id: source.id, region: 'content', excerpt: '写文件后没有运行测试，导致回归。' }],
      ...extra,
    })
    expect(result.outcome, JSON.stringify(result)).toBe('success')
    const d = result.draft as { draft_id: string; version: number }
    return { draft_id: d.draft_id, version: d.version }
  }

  async function authorize(draft: { draft_id: string; version: number }) {
    const result = await runtime.service.execute(leader(), { operation: 'present', ...draft })
    expect(result.outcome, JSON.stringify(result)).toBe('success')
    const p = result.presentation as { displayId: string; bodyHash: string }
    await bindAndAck(p.displayId, draft.version, p.bodyHash)
    const message = await seedUserMessage('确认保存上面完整的操作')
    expect((await runtime.service.confirmTurn(leader(message.id), classifierReturning('confirm'))).status).toBe('granted')
    return leader(message.id)
  }

  async function save(extra: Record<string, unknown> = {}) {
    const draft = await newDraft(extra)
    const context = await authorize(draft)
    const result = await runtime.service.execute(context, { operation: 'commit', ...draft })
    expect(result.outcome, JSON.stringify(result)).toBe('success')
    return (result.record as { record_id: string; revision: number })
  }

  it('RF14 首个工具结果落盘前关闭草稿，迟到快照/待写不能恢复输入；原生bytes与普通文本保留', async () => {
    const source = await seedAssistant('用于验证首结果前窗口的原始失败')
    const request = { ...DRAFT, problem: '首结果前关闭的专属正文', evidence: [{ message_id: source.id, region: 'content', excerpt: '用于验证首结果前窗口的原始失败' }] }
    const created = await runtime.service.execute({ ...leader(), toolCallId: 'before-result' }, request)
    expect(created.outcome, JSON.stringify(created)).toBe('success')
    const draft = created.draft as { draft_id: string; version: number }
    const saver = new PrismaCheckpointSaver(prisma)
    const config = { configurable: { thread_id: sessionId } }
    const checkpoint = { v: 4, id: randomUUID(), ts: new Date().toISOString(), channel_values: { messages: [new HumanMessage('用户自行引用：保持普通文本'), new AIMessage({ content: '', tool_calls: [{ id: 'before-result', name: 'reflection_records', args: request }] })] }, channel_versions: {}, versions_seen: {} }
    await saver.put(config, checkpoint, { source: 'input', step: 0, parents: {} })
    const other = await prisma.session.create({ data: { ownerId, containerId: 'binary-channel', title: '同owner二进制待写' } })
    await saver.putWrites({ configurable: { thread_id: other.id, checkpoint_id: 'binary-only' } }, [['native-bytes', new Uint8Array([1, 2, 3])]], 'binary-task')
    // 同用户无关的旧序列化数据不应被关闭目标草稿时全量解码。
    await prisma.checkpoint.create({ data: { threadId: other.id, checkpointId: 'unrelated-legacy', type: 'legacy-opaque', blob: new Uint8Array([255, 0, 1]) } })
    const legacy = await prisma.session.create({ data: { ownerId, containerId: 'legacy-fork', title: '未建立调用绑定的旧副本' } })
    const legacyMessage = new AIMessage({ content: '', tool_calls: [{ id: 'legacy-only', name: 'reflection_records', args: request }] })
    const legacyConfig = { configurable: { thread_id: legacy.id } }
    const legacyId = randomUUID()
    await saver.put(legacyConfig, { ...checkpoint, id: legacyId, channel_values: { messages: [legacyMessage] } }, { source: 'input', step: 0, parents: {} })
    await saver.put(legacyConfig, { ...checkpoint, id: randomUUID(), channel_values: { messages: [legacyMessage, new ToolMessage({ tool_call_id: 'legacy-only', name: 'reflection_records', content: JSON.stringify({ draft: { draft_id: draft.draft_id, version: 1 } }) })] } }, { source: 'loop', step: 1, parents: {} })
    expect((await runtime.service.execute(leader(), { operation: 'cancel', draft_id: draft.draft_id })).outcome).toBe('success')
    const legacyBeforeResult = await saver.getTuple({ configurable: { thread_id: legacy.id, checkpoint_id: legacyId } })
    expect(JSON.stringify(legacyBeforeResult)).not.toContain('首结果前关闭的专属正文')
    const lateId = randomUUID()
    const lateConfig = { configurable: { thread_id: sessionId, checkpoint_id: lateId } }
    await saver.put(config, { ...checkpoint, id: lateId }, { source: 'update', step: 1, parents: {} })
    await saver.putWrites(lateConfig, [['messages', checkpoint.channel_values.messages], ['native-bytes', new Uint8Array([4, 5, 6])]], 'late-before-result')
    const saved = await saver.getTuple(lateConfig)
    expect(saved).toBeDefined()
    expect(JSON.stringify(saved)).not.toContain('首结果前关闭的专属正文')
    expect(JSON.stringify(saved)).toContain('用户自行引用：保持普通文本')
    expect(saved!.pendingWrites?.find(write => write[1] === 'native-bytes')?.[2]).toEqual(new Uint8Array([4, 5, 6]))
  })

  it('RF10 修订正式记录：同 record 新 revision，元数据也须完整展示确认', async () => {
    const first = await save()
    const draft = await newDraft({ action: 'revise', targets: [{ record_id: first.record_id, version: 1 }], title: '更正后的教训' })
    const denied = await runtime.service.execute(leader(), { operation: 'commit', ...draft })
    expect(denied.error?.code).toBe('confirmation_required')
    const context = await authorize(draft)
    const saved = await runtime.service.execute(context, { operation: 'commit', ...draft })
    expect(saved.record).toMatchObject({ record_id: first.record_id, revision: 2 })
    const old = await runtime.service.execute({ ...leader(), managementIntent: true }, { operation: 'read', purpose: 'management', targets: [{ record_id: first.record_id, version: 1 }] })
    expect(old.records).toMatchObject([{ version: 1, is_current: false }])
    const replay = await runtime.service.execute(context, { operation: 'commit', ...draft })
    expect(replay.record).toMatchObject({ record_id: first.record_id, revision: 2 })
  })
  it('RF10 合并作为一个确认动作：来源去重，保留关系，源记录退出主动使用', async () => {
    const a = await save()
    const b = await save()
    const merged = await save({ action: 'merge', targets: [a, b].map(r => ({ record_id: r.record_id, version: 1 })) })
    expect(merged.record_id).not.toBe(a.record_id)
    const search = await runtime.service.execute(leader(), { operation: 'search' })
    expect(search.records).toMatchObject([{ record_id: merged.record_id }])
    expect(search.count).toBe(1)
    const draft = await newDraft({ action: 'replace', targets: [{ record_id: merged.record_id, version: 1 }] })
    const shown = await runtime.service.execute(leader(), { operation: 'present', ...draft })
    const display = await runtime.service.getDisplay(ownerId, (shown.presentation as { displayId: string }).displayId)
    expect(display).toMatchObject({ action: 'replace', targets: [{ record_id: merged.record_id, version: 1 }] })
    expect((await runtime.service.execute(leader(), { ...DRAFT, action: 'replace', targets: [{ record_id: a.record_id, version: 1 }], evidence: [] })).outcome).toBe('failure')
  })

  it('RF07/RF10 两会话同基准修订：后提交者整体冲突，旧确认不改写新版本', async () => {
    const first = await save()
    const targets = [{ record_id: first.record_id, version: 1 }]
    const a = await newDraft({ action: 'revise', targets, title: '会话 A 的修订' })
    const ca = await authorize(a)
    const originalSession = sessionId
    sessionId = (await prisma.session.create({ data: { ownerId, containerId: 'other-sandbox', title: '第二会话' } })).id
    const b = await newDraft({ action: 'revise', targets, title: '会话 B 的修订' })
    const cb = await authorize(b)
    expect((await runtime.service.execute(cb, { operation: 'commit', ...b })).outcome).toBe('success')
    sessionId = originalSession
    const conflict = await runtime.service.execute(ca, { operation: 'commit', ...a })
    expect(conflict.error?.code).toBe('conflict')
    expect(conflict.differences).toMatchObject([{ expected_version: 1, actual_version: 2 }])
    expect((await runtime.service.execute(leader(), { operation: 'read', targets: [{ record_id: first.record_id }] })).records).toMatchObject([{ title: '会话 B 的修订', version: 2 }])
  })

  it('RF10 合并中一源变化：所有源保持原状，不留下半个新记录', async () => {
    const a = await save()
    const b = await save()
    const merge = await newDraft({ action: 'merge', targets: [a, b].map(r => ({ record_id: r.record_id, version: 1 })) })
    const context = await authorize(merge)
    const originalSession = sessionId
    sessionId = (await prisma.session.create({ data: { ownerId, containerId: 'merge-race', title: '并发修改来源' } })).id
    await save({ action: 'revise', targets: [{ record_id: b.record_id, version: 1 }] })
    sessionId = originalSession
    const conflict = await runtime.service.execute(context, { operation: 'commit', ...merge })
    expect(conflict.error?.code).toBe('conflict')
    const search = await runtime.service.execute(leader(), { operation: 'search' })
    expect(search.count).toBe(2)
    expect((search.records as { status: string }[]).every(r => r.status === 'active')).toBe(true)
  })

  it('RF13 待复核经验不能合并洗白；剩余/补充原始证据重新确认才恢复 valid', async () => {
    const first = await save()
    // 真来源变更触发失效，不直接伪造记录状态。
    const original = await prisma.reflectionRecordEvidence.findFirstOrThrow({ where: { recordId: first.record_id } })
    await prisma.sessionMessage.update({ where: { id: original.messageId! }, data: { content: '原始内容已变化' } })
    const source = await seedAssistant('补充证据：仍然遗漏验证。')
    const base = { ...DRAFT, targets: [{ record_id: first.record_id, version: 1 }], evidence: [{ message_id: source.id, region: 'content', excerpt: '补充证据：仍然遗漏验证。' }] }
    expect((await runtime.service.execute(leader(), { ...base, action: 'merge' })).error?.code).toBe('not_ready')
    const draftResult = await runtime.service.execute(leader(), { ...base, action: 'review' })
    expect(draftResult.outcome).toBe('success')
    const raw = draftResult.draft as { draft_id: string; version: number }
    const draft = { draft_id: raw.draft_id, version: raw.version }
    expect((await runtime.service.execute(leader(), { operation: 'search' })).count).toBe(0)
    const context = await authorize(draft)
    expect((await runtime.service.execute(context, { operation: 'commit', ...draft })).record).toMatchObject({ record_id: first.record_id, revision: 2, evidence_status: 'valid' })
    await prisma.sessionMessage.update({ where: { id: original.messageId! }, data: { content: '旧版本来源再次变化' } })
    expect((await runtime.service.execute(leader(), { operation: 'search' })).count).toBe(1)
  })

  it('RF23 同主请求同 episode 经 runtime 重建仍只产生一个草稿；新证据可再分析', async () => {
    const source = await seedAssistant('写文件后没有运行测试，导致回归。')
    const trigger = await seedUserMessage('纠正刚才的验证遗漏并继续任务')
    const input = { ...DRAFT, evidence: [{ message_id: source.id, region: 'content', excerpt: '写文件后没有运行测试，导致回归。' }] }
    const context = { ...leader(trigger.id), requestId: trigger.id }
    const first = await runtime.service.execute(context, input)
    runtime.dispose()
    runtime = createReflectionsRuntime(prisma)
    const repeated = await runtime.service.execute(context, { ...input, title: '换个标题重复反思' })
    expect((repeated.draft as { draft_id: string }).draft_id).toBe((first.draft as { draft_id: string }).draft_id)
    expect(repeated.status).toBe('already_analyzed')
    await prisma.sessionMessage.update({ where: { id: source.id }, data: { content: '写文件后没有运行测试，导致回归。新证据版本' } })
    const fresh = await runtime.service.execute(context, input)
    expect((fresh.draft as { draft_id: string }).draft_id).not.toBe((first.draft as { draft_id: string }).draft_id)
  })

  it('RF10 原始来源重复去重但合并保留每条来源关系', async () => {
    const source = await seedAssistant('共享原始证据')
    const evidence = [{ message_id: source.id, region: 'content', excerpt: '共享原始证据' }]
    const a = await save({ evidence })
    const b = await save({ evidence })
    const draft = await newDraft({ action: 'merge', targets: [a, b].map(r => ({ record_id: r.record_id, version: 1 })), evidence: [...evidence, ...evidence] })
    const presented = await runtime.service.execute(leader(), { operation: 'present', ...draft })
    const display = await runtime.service.getDisplay(ownerId, (presented.presentation as { displayId: string }).displayId)
    expect(display?.evidence).toHaveLength(1)
    expect(display?.targets).toHaveLength(2)
    expect(display?.body?.causes[0].evidence).toEqual([1])
  })

  it('RF07/RF13 事务前真实连接屏障：授权后来源变化不保存', async () => {
    const draft = await newDraft()
    const context = await authorize(draft)
    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>(r => { entered = r })
    const gate = new Promise<void>(r => { release = r })
    const delayed = createReflectionsRuntime(prisma, {}, { beforeCommitTransaction: async () => { entered(); await gate } })
    const committing = delayed.service.execute(context, { operation: 'commit', ...draft })
    await reached
    const original = await prisma.reflectionEvidence.findFirstOrThrow({ where: { draftId: draft.draft_id } })
    const writer = createPrismaClient(process.env.DATABASE_URL!)
    await writer.sessionMessage.update({ where: { id: original.messageId! }, data: { content: '独立连接在提交前更改来源' } })
    await writer.$disconnect()
    release()
    expect((await committing).outcome).toBe('failure')
    expect((await runtime.service.execute(leader(), { operation: 'search' })).count).toBe(0)
    delayed.dispose()
  })

  it('RF07 授权后墓碑 generation 变化或目标删除，旧确认不能复活记录', async () => {
    const first = await save()
    const draft = await newDraft({ action: 'replace', targets: [{ record_id: first.record_id, version: 1 }] })
    const context = await authorize(draft)
    await prisma.reflectionRecord.update({ where: { id: first.record_id }, data: { generation: { increment: 1 }, status: 'deleted', contentJson: '{}' } })
    const result = await runtime.service.execute(context, { operation: 'commit', ...draft })
    expect(result.error?.code).toBe('conflict')
    expect(result.differences).toMatchObject([{ expected_generation: 1, actual_generation: 2, status: 'deleted' }])
    expect((await runtime.service.execute(leader(), { operation: 'search' })).count).toBe(0)
  })

  it('RF10 已替代的源不能重新作为替代目标形成环；merge 最多 8 个目标', async () => {
    const first = await save()
    await save({ action: 'replace', targets: [{ record_id: first.record_id, version: 1 }] })
    const source = await seedAssistant('范围证据')
    const input = { ...DRAFT, evidence: [{ message_id: source.id, region: 'content', excerpt: '范围证据' }] }
    expect((await runtime.service.execute(leader(), { ...input, action: 'replace', targets: [{ record_id: first.record_id, version: 1 }] })).error?.code).toBe('conflict')
    expect((await runtime.service.execute(leader(), { ...input, action: 'merge', targets: Array.from({ length: 9 }, (_, i) => ({ record_id: `record-${i}`, version: 1 })) })).error?.code).toBe('invalid_parameters')
  })

  it('RF13 修改未提交合并草稿仍保留全部根证据，源变化继续使结果失效', async () => {
    const a = await save()
    const b = await save()
    const draft = await newDraft({ action: 'merge', targets: [a, b].map(r => ({ record_id: r.record_id, version: 1 })) })
    const source = await seedAssistant('修订合并描述的补充来源')
    const updated = await runtime.service.execute(leader(), {
      ...DRAFT, action: 'revise', draft_id: draft.draft_id, base_version: 1,
      evidence: [{ message_id: source.id, region: 'content', excerpt: '修订合并描述的补充来源' }],
    })
    expect(updated.outcome).toBe('success')
    const revised = { draft_id: draft.draft_id, version: 2 }
    const context = await authorize(revised)
    const saved = await runtime.service.execute(context, { operation: 'commit', ...revised })
    expect(saved.outcome).toBe('success')
    const root = await prisma.reflectionRecordEvidence.findFirstOrThrow({ where: { recordId: a.record_id } })
    await prisma.sessionMessage.update({ where: { id: root.messageId! }, data: { content: '合并后原始来源变化' } })
    expect((await runtime.service.execute(leader(), { operation: 'search' })).count).toBe(0)
    const record = saved.record as { record_id: string }
    const management = await runtime.service.execute({ ...leader(), managementIntent: true }, { operation: 'read', purpose: 'management', targets: [{ record_id: record.record_id }] })
    expect(management.records).toMatchObject([{ evidence_status: 'review_required' }])
  })

  it('RF10 合并继承来源后超过8证据或整体32KiB，拒绝且不改变源记录', async () => {
    const ids: string[] = []
    for (let i = 0; i < 8; i++) ids.push((await seedAssistant(`原始证据${i}`)).id)
    const evidence = ids.map((id, i) => ({ message_id: id, region: 'content', excerpt: `原始证据${i}` }))
    const a = await save({ evidence })
    const source = await seedAssistant('新增第九条')
    const result = await runtime.service.execute(leader(), { ...DRAFT, action: 'replace', targets: [{ record_id: a.record_id, version: 1 }], evidence: [{ message_id: source.id, region: 'content', excerpt: '新增第九条' }] })
    expect(result.error?.code).toBe('limit')
    const tooLarge = await runtime.service.execute(leader(), { ...DRAFT, action: 'replace', problem: '界'.repeat(10300), targets: [{ record_id: a.record_id, version: 1 }], evidence: [evidence[0]] })
    expect(tooLarge.error?.code).toBe('limit')
    expect((await runtime.service.execute(leader(), { operation: 'search' })).count).toBe(1)
  })

  it('RF07 修订未提交草稿后，旧版来源变化不误撤新版确认授权', async () => {
    const draft = await newDraft()
    const old = await prisma.reflectionEvidence.findFirstOrThrow({ where: { draftId: draft.draft_id } })
    const source = await seedAssistant('新版草稿的独立原始证据')
    const result = await runtime.service.execute(leader(), { ...DRAFT, action: 'revise', draft_id: draft.draft_id, base_version: 1, evidence: [{ message_id: source.id, region: 'content', excerpt: '新版草稿的独立原始证据' }] })
    expect(result.outcome).toBe('success')
    const revised = { draft_id: draft.draft_id, version: 2 }
    const context = await authorize(revised)
    await prisma.sessionMessage.update({ where: { id: old.messageId! }, data: { content: '旧版来源已变化' } })
    expect((await runtime.service.execute(context, { operation: 'commit', ...revised })).outcome).toBe('success')
  })

  it('RF11 停用/恢复沿用完整展示确认，恢复待复核记录不洗白证据', async () => {
    const first = await save()
    const lifecycle = async (action: string) => {
      const result = await runtime.service.execute(leader(), { operation: 'draft', action, targets: [{ record_id: first.record_id, version: 1 }] })
      expect(result.outcome, JSON.stringify(result)).toBe('success')
      const rawDraft = result.draft as { draft_id: string; version: number }
      const draft = { draft_id: rawDraft.draft_id, version: rawDraft.version }
      expect((await runtime.service.execute(leader(), { operation: 'commit', ...draft })).error?.code).toBe('confirmation_required')
      return runtime.service.execute(await authorize(draft), { operation: 'commit', ...draft })
    }
    expect((await lifecycle('deactivate')).record).toMatchObject({ record_id: first.record_id, status: 'inactive' })
    expect((await runtime.service.execute(leader(), { operation: 'search' })).count).toBe(0)
    const original = await prisma.reflectionRecordEvidence.findFirstOrThrow({ where: { recordId: first.record_id } })
    await prisma.sessionMessage.update({ where: { id: original.messageId! }, data: { content: '来源变化' } })
    expect((await lifecycle('reactivate')).record).toMatchObject({ status: 'active', evidence_status: 'review_required' })
    expect((await runtime.service.execute(leader(), { operation: 'search' })).count).toBe(0)
  })

  it('RF07/RF14 硬删阻止两会话旧草稿、旧保存幂等和迟到确认复活，展示回放只有占位', async () => {
    const first = await save()
    const stale = await newDraft({ action: 'revise', targets: [{ record_id: first.record_id, version: 1 }] })
    const staleContext = await authorize(stale)
    const display = await prisma.reflectionPresentation.findFirstOrThrow({ where: { draftId: stale.draft_id } })
    const originalSession = sessionId
    sessionId = (await prisma.session.create({ data: { ownerId, containerId: 'delete-other', title: '第二会话删除' } })).id
    const result = await runtime.service.execute(leader(), { operation: 'draft', action: 'delete', targets: [{ record_id: first.record_id, version: 1 }] })
    expect(result.outcome, JSON.stringify(result)).toBe('success')
    const rawDraft = result.draft as { draft_id: string; version: number }
      const draft = { draft_id: rawDraft.draft_id, version: rawDraft.version }
    const context = await authorize(draft)
    expect((await runtime.service.execute(context, { operation: 'commit', ...draft })).record).toMatchObject({ status: 'deleted' })
    expect((await runtime.service.execute(staleContext, { operation: 'commit', ...stale })).outcome).toBe('failure')
    expect(await runtime.service.getDisplay(ownerId, display.displayId)).toMatchObject({ deleted: true, body: null, evidence: [] })
    expect(await runtime.service.draftBodyText(ownerId, stale.draft_id, 1)).toBeNull()
    expect(await runtime.service.recordBodyText(ownerId, first.record_id, 1)).toBeNull()
    expect((await runtime.service.execute(leader(), { operation: 'draft', action: 'reactivate', targets: [{ record_id: first.record_id, version: 1 }] })).outcome).toBe('failure')
    expect(await prisma.reflectionRevision.count({ where: { recordId: first.record_id } })).toBe(0)
    expect(await prisma.reflectionRecordEvidence.count({ where: { recordId: first.record_id } })).toBe(0)
    expect(await prisma.reflectionRecord.findUnique({ where: { id: first.record_id } })).toMatchObject({ contentJson: '{}', title: '', generation: 2 })
    sessionId = originalSession
  })

  it('RF15 注入时钟的启动清理清除30天未确认草稿/展示，过期授权不重签', async () => {
    const draft = await newDraft()
    const context = await authorize(draft)
    const presentation = await prisma.reflectionPresentation.findFirstOrThrow({ where: { draftId: draft.draft_id } })
    const cleanup = new ReflectionCleanupService(prisma, { clock: () => Date.now() + 31 * 86400000 })
    await cleanup.processPending()
    expect(await runtime.service.getDisplay(ownerId, presentation.displayId)).toMatchObject({ deleted: true, body: null })
    expect(await runtime.service.draftBodyText(ownerId, draft.draft_id, 1)).toBeNull()
    expect((await runtime.service.execute(context, { operation: 'commit', ...draft })).outcome).toBe('failure')
    expect((await runtime.service.confirmTurn(context, classifierReturning('confirm'))).status).not.toBe('granted')
    expect((await runtime.service.execute(leader(), { ...DRAFT, action: 'revise', draft_id: draft.draft_id, base_version: 1,
      evidence: [{ message_id: (await seedAssistant('补充证据')).id, region: 'content', excerpt: '补充证据' }] })).outcome).toBe('failure')
  })

  it('RF15 每用户100活跃及滚动24小时100新建，撤回清副本也不重置新建额度', async () => {
    const source = await seedAssistant('限额验证证据')
    const input = { ...DRAFT, evidence: [{ message_id: source.id, region: 'content', excerpt: '限额验证证据' }] }
    const drafts: { draft_id: string; version: number }[] = []
    for (let i = 0; i < 100; i++) {
      const result = await runtime.service.execute(leader(), input)
      expect(result.outcome).toBe('success')
      drafts.push(result.draft as { draft_id: string; version: number })
    }
    expect((await runtime.service.execute(leader(), input)).error?.code).toBe('limit')
    const draft = drafts[0]
    await runtime.service.execute(leader(), { operation: 'cancel', draft_id: draft.draft_id })
    expect((await runtime.service.execute(leader(), input)).error?.code).toBe('limit')
    const later = createReflectionsRuntime(prisma, { clock: () => Date.now() + 86400001 })
    expect((await later.service.execute(leader(), input)).outcome).toBe('success')
    expect((await later.service.execute(leader(), input)).error?.code).toBe('limit')
    later.dispose()
    await prisma.session.delete({ where: { id: sessionId } })
    sessionId = (await prisma.session.create({ data: { ownerId, containerId: 'after-quota-delete', title: '删除会话后额度' } })).id
    const freshSource = await seedAssistant('新会话证据')
    expect((await runtime.service.execute(leader(), { ...DRAFT, evidence: [{ message_id: freshSource.id, region: 'content', excerpt: '新会话证据' }] })).error?.code).toBe('limit')
  })

  it('RF07/RF14 独立连接删除与保存竞态：硬删提交后，延迟保存不能写回正文', async () => {
    const first = await save()
    const stale = await newDraft({ action: 'revise', targets: [{ record_id: first.record_id, version: 1 }] })
    const context = await authorize(stale)
    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    const delayed = createReflectionsRuntime(prisma, {}, { beforeCommitTransaction: async () => { entered(); await barrier } })
    const saving = delayed.service.execute(context, { operation: 'commit', ...stale })
    await reached
    const originalSession = sessionId
    const writer = createPrismaClient(process.env.DATABASE_URL!)
    const other = createReflectionsRuntime(writer)
    try {
      sessionId = (await writer.session.create({ data: { ownerId, containerId: 'delete-race', title: '竞态删除' } })).id
      const result = await other.service.execute(leader(), { operation: 'draft', action: 'delete', targets: [{ record_id: first.record_id, version: 1 }] })
      const raw = result.draft as { draft_id: string; version: number }
      const draft = { draft_id: raw.draft_id, version: raw.version }
      const confirmation = await authorize(draft)
      expect((await other.service.execute(confirmation, { operation: 'commit', ...draft })).outcome).toBe('success')
    } finally {
      sessionId = originalSession
      release()
      other.dispose()
      await writer.$disconnect()
    }
    expect((await saving).outcome).toBe('failure')
    expect(await runtime.service.recordBodyText(ownerId, first.record_id, 1)).toBeNull()
    delayed.dispose()
  })

  it('RF14/RF15 幂等30天过期后仍能清初始草稿，独立合并派生记录保留', async () => {
    const first = await save()
    const second = await save()
    const merged = await save({ action: 'merge', targets: [first, second].map(r => ({ record_id: r.record_id, version: 1 })) })
    await new ReflectionCleanupService(prisma, { clock: () => Date.now() + 31 * 86400000 }).processPending()
    expect(await prisma.reflectionIdempotency.count()).toBe(0)
    const result = await runtime.service.execute(leader(), { operation: 'draft', action: 'delete', targets: [{ record_id: first.record_id, version: 1 }] })
    const raw = result.draft as { draft_id: string; version: number }
    const draft = { draft_id: raw.draft_id, version: raw.version }
    expect((await runtime.service.execute(await authorize(draft), { operation: 'commit', ...draft })).outcome).toBe('success')
    const search = await runtime.service.execute(leader(), { operation: 'search' })
    expect(search.records).toMatchObject([{ record_id: merged.record_id }])
    const original = await prisma.reflectionDraft.findFirstOrThrow({ where: { committedRecordId: first.record_id } })
    expect(original.contentJson).toBe('{}')
    expect(await prisma.reflectionPresentation.findMany({ where: { draftId: original.id } })).toMatchObject([{ status: 'deleted', bodyJson: '{}' }])
  })

  it('RF15 操作日志保留90天，账号删除清墓碑与清理队列且不产生孤儿副本', async () => {
    const originalOwner = ownerId
    const originalSession = sessionId
    ownerId = (await seedUser(prisma, 'rf-delete-account', 'pw-delete-account-secure')).id
    sessionId = (await prisma.session.create({ data: { ownerId, containerId: 'delete-account', title: '账号删除' } })).id
    try {
      const first = await save()
      await new ReflectionCleanupService(prisma, { clock: () => Date.now() + 91 * 86400000 }).processPending()
      expect(await prisma.reflectionEvent.count({ where: { ownerId } })).toBe(0)
      expect(await prisma.reflectionRecord.count({ where: { id: first.record_id } })).toBe(1)
      // 真实账号删除同时触发会话/消息级联与反思来源触发器。
      await prisma.user.delete({ where: { id: ownerId } })
      expect(await prisma.reflectionRecord.count({ where: { ownerId } })).toBe(0)
      expect(await prisma.reflectionGrant.count({ where: { ownerId } })).toBe(0)
      expect(await prisma.reflectionCleanupOutbox.count({ where: { ownerId } })).toBe(0)
      expect(await prisma.reflectionDraft.count({ where: { ownerId } })).toBe(0)
    } finally {
      ownerId = originalOwner
      sessionId = originalSession
    }
  })

  it('RF07 停用再恢复仍改变 generation，旧 active 基准不能在状态绕回后生效', async () => {
    const first = await save()
    const stale = await newDraft({ action: 'revise', targets: [{ record_id: first.record_id, version: 1 }] })
    const context = await authorize(stale)
    const originalSession = sessionId
    sessionId = (await prisma.session.create({ data: { ownerId, containerId: 'lifecycle-roundtrip', title: '停用与恢复' } })).id
    try {
      for (const action of ['deactivate', 'reactivate']) {
        const result = await runtime.service.execute(leader(), { operation: 'draft', action, targets: [{ record_id: first.record_id, version: 1 }] })
        const raw = result.draft as { draft_id: string; version: number }
        const draft = { draft_id: raw.draft_id, version: raw.version }
        expect((await runtime.service.execute(await authorize(draft), { operation: 'commit', ...draft })).outcome).toBe('success')
      }
    } finally { sessionId = originalSession }
    const result = await runtime.service.execute(context, { operation: 'commit', ...stale })
    expect(result.error?.code).toBe('conflict')
    expect(result.differences).toMatchObject([{ expected_generation: 1, actual_generation: 3 }])
  })

  it('RF14 来源失效后硬删同步清专属 outbox；共享来源的独立记录清理仍可重放', async () => {
    const first = await save()
    const source = await prisma.reflectionRecordEvidence.findFirstOrThrow({ where: { recordId: first.record_id } })
    await prisma.sessionMessage.update({ where: { id: source.messageId! }, data: { content: '来源已变更' } })
    expect(await prisma.reflectionCleanupOutbox.count({ where: { ownerId, messageId: source.messageId, state: 'pending' } })).toBeGreaterThan(0)
    const result = await runtime.service.execute(leader(), { operation: 'draft', action: 'delete', targets: [{ record_id: first.record_id, version: 1 }] })
    const raw = result.draft as { draft_id: string; version: number }
    const draft = { draft_id: raw.draft_id, version: raw.version }
    expect((await runtime.service.execute(await authorize(draft), { operation: 'commit', ...draft })).outcome).toBe('success')
    expect(await prisma.reflectionCleanupOutbox.count({ where: { ownerId, messageId: source.messageId } })).toBe(0)
  })

})
