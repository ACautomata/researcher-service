// #1088 固定场景数据构造：只建独立临时 SQLite；模型调用由外层显式命令负责。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { PrismaClient } from '../../src/generated/prisma/client'
import { createPrismaClient } from '../../src/prisma'
import { createReflectionsRuntime, type ReflectionsRuntime } from '../../src/reflections/runtime'
import { createHistoryRuntime } from '../../src/sessions/history/runtime'
import { serializeAttachments } from '../../src/sessions/reducer'
import type { ReflectionContext, ConfirmationClassifier } from '../../src/reflections/model'
import { seedUser } from '../../test/helpers'
import { z } from 'zod'

export const AnalysisCaseSchema = z.object({
  id: z.string(), category: z.enum(['understanding', 'planning', 'tool_use', 'verification', 'efficiency', 'information_access']),
  user: z.string(), source_scenario: z.string(), review_anchor: z.string(), expected_disposition: z.string(),
  setup: z.object({
    source: z.string(), extra: z.array(z.string()).default([]),
    access: z.enum(['own', 'foreign', 'teammate']).default('own'),
    toolResult: z.string().optional(), truncated: z.boolean().default(false),
    experience: z.enum(['none', 'active', 'conflicting', 'invalid']).default('none'),
    completedEpisode: z.boolean().default(false), reopen: z.boolean().default(false),
    canary: z.string().optional(),
  }),
})
export type AnalysisCase = z.infer<typeof AnalysisCaseSchema>
export interface FixtureSource { id: string; sessionId: string; region: string; toolCallId?: string; content: string; authorized: boolean; truncated: boolean }

export async function presentFixtureDraft(runtime: ReflectionsRuntime, prisma: PrismaClient, context: ReflectionContext, draft: { draft_id: string; version: number }) {
  const result = await runtime.service.execute(context, { operation: 'present', ...draft })
  if (result.outcome !== 'success') throw new Error(`fixture presentation failed: ${result.error?.code}`)
  const ref = result.presentation as { displayId: string; draftId: string; bodyHash: string; status: 'preparing' | 'pending'; confirmable: boolean }
  const last = await prisma.sessionMessage.findFirst({ where: { sessionId: context.currentSessionId }, orderBy: { turn: 'desc' } })
  const row = await prisma.sessionMessage.create({ data: { sessionId: context.currentSessionId, turn: (last?.turn ?? 0) + 1, role: 'assistant', content: '完整展示反思操作', attachmentsJson: serializeAttachments({ presentations: [{ ...ref, draftId: draft.draft_id, version: draft.version }] }) } })
  await runtime.store.bindInFlightEvidence({ ownerId: context.ownerId, sessionId: context.currentSessionId, runId: context.runId ?? 'fixture', messageId: row.id, displayIds: [ref.displayId] })
  return { ...ref, messageId: row.id, version: draft.version }
}

export async function createAnalysisFixture(input: AnalysisCase, options: { classifier?: ConfirmationClassifier } = {}) {
  const item = AnalysisCaseSchema.parse(input)
  const dir = mkdtempSync(join(tmpdir(), 'rf-1088-fixture-'))
  const dbPath = join(dir, 'fixture.db')
  let prisma: PrismaClient | undefined
  let reflection: ReflectionsRuntime | undefined
  let history: ReturnType<typeof createHistoryRuntime> | undefined
  const dispose = async () => {
    await Promise.allSettled([reflection?.dispose(), history?.dispose()])
    try { await prisma?.$disconnect() } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  try {
    const db = new Database(dbPath)
    try {
      for (const file of ['init.sql', 'history-triggers.sql', 'reflection-triggers.sql', 'reflection-owner-trigger.sql', 'reflection-recovery.sql']) db.exec(readFileSync(join(__dirname, '../../prisma', file), 'utf8'))
    } finally { db.close() }
    prisma = createPrismaClient(`file:${dbPath}`)
    reflection = createReflectionsRuntime(prisma, { dbPath, cursorSweepMs: 0, ...options })
    history = createHistoryRuntime({ prisma, dbPath })
    const owner = await seedUser(prisma, 'rf-eval', 'synthetic-evaluation-password')
    const sourceOwner = item.setup.access === 'foreign' ? await seedUser(prisma, 'rf-other', 'synthetic-other-password') : owner
    const past = await prisma.session.create({ data: { ownerId: sourceOwner.id, containerId: 'eval-past', title: `固定失败 ${item.id}`, isTeammate: item.setup.access === 'teammate' } })
    const current = await prisma.session.create({ data: { ownerId: owner.id, containerId: 'eval-current', title: '当前评测任务' } })
    const sources: FixtureSource[] = []
    const source = await prisma.sessionMessage.create({ data: { sessionId: past.id, turn: 1, role: 'assistant', content: item.setup.source,
      attachmentsJson: item.setup.toolResult ? serializeAttachments({ tools: [{ toolCallId: 'fixed-tool', name: 'execute', input: '固定测试命令', state: 'error', details: item.setup.toolResult, truncated: item.setup.truncated }] }) : serializeAttachments({}) } })
    sources.push({ id: source.id, sessionId: past.id, region: 'content', content: source.content, authorized: item.setup.access === 'own', truncated: false })
    if (item.setup.toolResult) sources.push({ id: source.id, sessionId: past.id, region: 'tool_result', toolCallId: 'fixed-tool', content: item.setup.toolResult, authorized: item.setup.access === 'own', truncated: item.setup.truncated })
    for (const text of item.setup.extra) {
      const row = await prisma.sessionMessage.create({ data: { sessionId: past.id, turn: sources.length + 10, role: 'assistant', content: text, attachmentsJson: serializeAttachments({}) } })
      sources.push({ id: row.id, sessionId: past.id, region: 'content', content: text, authorized: item.setup.access === 'own', truncated: false })
    }
    const priorRecordIds: string[] = []
    if (item.setup.experience !== 'none') {
      const ctx = { ownerId: owner.id, currentSessionId: past.id, role: 'leader' as const, requestId: `setup-${item.id}` }
      const draftResult = await reflection.service.execute(ctx, { operation: 'draft', action: 'create', category: item.category, title: '既有经验：' + item.category, problem: item.setup.source,
        causes: [{ text: '原始消息中的行为已发生', kind: 'fact', evidence: [1] }], improvements: [item.setup.experience === 'conflicting' ? '遇到发布任务，先发布后验收；为了速度省略验证。' : '遇到同样问题，按原始约束执行并先做聚焦验证。'],
        scope: { labels: [item.category], conditions: '同一约束和原始证据', exclusions: '用户明确给出新的要求时' }, evidence: [{ message_id: source.id, region: 'content', excerpt: source.content }] })
      if (draftResult.outcome !== 'success') throw new Error('fixture prior draft failed')
      const { draft_id, version } = draftResult.draft as { draft_id: string; version: number }
      const shown = await presentFixtureDraft(reflection, prisma, ctx, { draft_id, version })
      await reflection.service.ackDisplay(owner.id, shown.displayId, { version, hash: shown.bodyHash, messageId: shown.messageId })
      const confirm = await prisma.sessionMessage.create({ data: { sessionId: past.id, turn: 100, role: 'user', content: '确认保存当前完整版本', attachmentsJson: serializeAttachments({}) } })
      const trusted = { ...ctx, triggerMessageId: confirm.id }
      if ((await reflection.service.confirmTurn(trusted, async () => ({ decision: 'confirm' }))).status !== 'granted') throw new Error('fixture prior grant failed')
      const saved = await reflection.service.execute(trusted, { operation: 'commit', draft_id, version })
      if (saved.outcome !== 'success') throw new Error('fixture prior record failed')
      priorRecordIds.push((saved.record as { record_id: string }).record_id)
      if (item.setup.experience === 'invalid') {
        await prisma.sessionMessage.update({ where: { id: source.id }, data: { content: '原消息已更正：这条旧经验的支撑不再有效。' } })
        sources[0].content = '原消息已更正：这条旧经验的支撑不再有效。'
      }
    }
    const user = await prisma.sessionMessage.create({ data: { sessionId: current.id, turn: 1, role: 'user', content: item.user, attachmentsJson: serializeAttachments({}) } })
    const context: ReflectionContext = { ownerId: owner.id, currentSessionId: current.id, role: 'leader', requestId: user.id, triggerMessageId: user.id }
    await history.resolveRunRequest({ kind: 'message', runId: 'fixture-run', ownerId: owner.id, sessionId: current.id, triggerMessageId: user.id })
    if (item.setup.completedEpisode) await reflection.store.completeAnalysis(context)
    if (item.setup.reopen) { await reflection.dispose(); reflection = createReflectionsRuntime(prisma, { dbPath, cursorSweepMs: 0, ...options }) }
    const baselineRecords = await prisma.reflectionRecord.count()
    return { prisma, reflection, history, owner, past, current, source, user, context, sources, priorRecordIds, baselineRecords, canary: item.setup.canary, dispose }
  } catch (error) { await dispose(); throw error }
}
