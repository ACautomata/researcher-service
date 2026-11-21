// #1081（RF-T05）真实图接缝：确认识别在 Leader 图执行前运行，commit 只凭可信上下文消费授权。
//
// 断言：Leader 工具只有 draftId/version，不能自批；有真实用户确认（注入分类器）才产生正式记录；
// 分类为不确认时工具明确回 confirmation_required，记录不落库。

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { AIMessage } from '@langchain/core/messages'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { PrismaCheckpointSaver } from '../src/runner/persistence/prismaCheckpointSaver'
import { ProviderRegistry } from '../src/runner/providerRegistry'
import { ConcurrencyGate } from '../src/runner/concurrency'
import { RunService, type RunCommand } from '../src/runner/runtime/runService'
import { createReflectionsRuntime, type ReflectionsRuntime } from '../src/reflections/runtime'
import { serializeAttachments } from '../src/sessions/reducer'
import { seedUser } from './helpers'
import { ScriptedChatModel, fakePrimitives, CollectingHub, toolCallAi } from './runnerFakes'
import { installAbortRejectionGuard } from '../src/runner/runtime/abortGuard'

const LAB = 'researcher-sandbox-rfgraph'
const WIKI = 'researcher-wiki-rfgraph'

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

describe('#1081 反思确认授权：真实图无自批通道', () => {
  let dir: string
  let prisma: PrismaClient
  let runtime: ReflectionsRuntime
  let owner: { id: string; username: string }
  let sessionId: string
  let turn: number
  let hub: CollectingHub

  beforeAll(async () => {
    installAbortRejectionGuard()
    dir = mkdtempSync(path.join(tmpdir(), `runner-1081-${process.pid}-`))
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    runtime = createReflectionsRuntime(prisma)
    const user = await seedUser(prisma, 'rf-graph-owner', 'pw-rf-graph-secure')
    owner = { id: user.id, username: user.username }
    await prisma.modelProvider.create({
      data: { ownerId: user.id, providerId: 'prov-rf', presetId: 'openai', modelsJson: JSON.stringify([{ id: 'model-rf' }]) },
    })
    hub = new CollectingHub()
  }, 30_000)

  beforeEach(async () => {
    const session = await prisma.session.create({ data: { ownerId: owner.id, containerId: LAB, title: '反思图会话' } })
    sessionId = session.id
    turn = 100
  })

  afterAll(async () => {
    await prisma.$disconnect()
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
    await prisma.session.deleteMany({ where: { id: sessionId } })
  })

  const leader = (triggerMessageId?: string) => ({
    ownerId: owner.id,
    currentSessionId: sessionId,
    role: 'leader' as const,
    ...(triggerMessageId ? { triggerMessageId } : {}),
  })

  async function seedAckedPresentation(): Promise<{ draftId: string; version: number; displayId: string }> {
    turn += 1
    const source = await prisma.sessionMessage.create({
      data: { sessionId, turn, role: 'assistant', content: '写文件后没有运行测试，导致回归。', attachmentsJson: serializeAttachments({ thinking: '思考' }) },
    })
    const created = await runtime.service.execute(leader(), {
      ...DRAFT,
      evidence: [{ session_id: sessionId, message_id: source.id, region: 'content', excerpt: '写文件后没有运行测试，导致回归。' }],
    })
    expect(created.outcome).toBe('success')
    const draft = created.draft as { draft_id: string; version: number }
    const presented = await runtime.service.execute(leader(), { operation: 'present', draft_id: draft.draft_id, version: draft.version })
    expect(presented.outcome).toBe('success')
    const presentation = presented.presentation as { displayId: string; bodyHash: string }
    turn += 1
    const bound = await prisma.sessionMessage.create({
      data: {
        sessionId,
        turn,
        role: 'assistant',
        content: '这是反思草稿。',
        attachmentsJson: serializeAttachments({ presentations: [{ displayId: presentation.displayId, draftId: draft.draft_id, version: draft.version, bodyHash: presentation.bodyHash, status: 'pending' as never, confirmable: true }] }),
      },
    })
    await runtime.store.bindInFlightEvidence({ ownerId: owner.id, sessionId, runId: 'run-unused', messageId: bound.id, displayIds: [presentation.displayId] })
    const acked = await runtime.service.ackDisplay(owner.id, presentation.displayId, { version: draft.version, hash: presentation.bodyHash, messageId: bound.id })
    expect('seq' in acked).toBe(true)
    return { draftId: draft.draft_id, version: draft.version, displayId: presentation.displayId }
  }

  function makeService(
    script: ConstructorParameters<typeof ScriptedChatModel>[0],
    models: ScriptedChatModel[],
    port = runtime.port,
    interruptPolicyFor?: (sessionId: string) => { tools: readonly string[] } | undefined,
  ): RunService {
    const registry = new ProviderRegistry(prisma, {
      llmApiKey: 'test-key',
      modelFactory: async () => {
        const model = new ScriptedChatModel(script)
        models.push(model)
        return model
      },
    })
    return new RunService({
      prisma,
      registry,
      saver: new PrismaCheckpointSaver(prisma),
      gate: new ConcurrencyGate({ globalLimit: 8, loadUserLimit: async () => 4 }),
      hub,
      primitives: fakePrimitives().primitives,
      resolveWikiContainer: () => WIKI,
      reflections: port,
      ...(interruptPolicyFor ? { interruptPolicyFor } : {}),
      clock: () => Date.now(),
    })
  }

  function cmd(p: Partial<RunCommand> = {}): RunCommand {
    return {
      runId: `run-${Math.random().toString(36).slice(2, 10)}`,
      sessionId,
      ownerId: owner.id,
      username: owner.username,
      kind: 'message',
      content: '确认保存',
      ...p,
    }
  }

  async function seedOwningMessage(content: string): Promise<string> {
    turn += 1
    const row = await prisma.sessionMessage.create({ data: { sessionId, turn, role: 'user', content } })
    return row.id
  }

  it('用户真实确认 → 图内 Leader 工具 commit 保存成功恰一条记录', async () => {
    const display = await seedAckedPresentation()
    const triggerId = await seedOwningMessage('好，就按这版保存')
    const models: ScriptedChatModel[] = []
    const confirming = createReflectionsRuntime(prisma, { classifier: async () => ({ decision: 'confirm' }) })
    const svc = makeService([
      toolCallAi('call-commit-1', 'reflection_records', { operation: 'commit', draft_id: display.draftId, version: display.version }),
      new AIMessage('已保存。'),
    ], models, confirming.port)
    await svc.execute(cmd({ triggerMessageId: triggerId }))

    expect(await prisma.reflectionRecord.count({ where: { ownerId: owner.id } })).toBe(1)
    const active = models.find((m) => m.invokeCount > 0)
    expect(active, '应至少调用一次模型').toBeDefined()
    const secondCall = active!.receivedMessages[1] as Array<{ content: unknown; _getType?: () => string }> | undefined
    expect(secondCall, '第二次模型调用应包含工具结果').toBeDefined()
    const toolText = secondCall!.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
    expect(toolText).toContain('record_id')
    expect(toolText).not.toContain('confirmation_required')
  })

  it('用户未确认 → Leader 工具 commit 只回 confirmation_required，不能自批保存', async () => {
    const display = await seedAckedPresentation()
    const triggerId = await seedOwningMessage('先等等，我还没想好')
    const models: ScriptedChatModel[] = []
    const unconfirmed = createReflectionsRuntime(prisma, { classifier: async () => ({ decision: 'unrelated' }) })
    const svc = makeService([
      toolCallAi('call-commit-2', 'reflection_records', { operation: 'commit', draft_id: display.draftId, version: display.version }),
      new AIMessage('没有保存。'),
    ], models, unconfirmed.port)
    await svc.execute(cmd({ triggerMessageId: triggerId }))

    expect(await prisma.reflectionRecord.count({ where: { ownerId: owner.id } })).toBe(0)
    const active = models.find((m) => m.invokeCount > 0)
    expect(active, '应至少调用一次模型').toBeDefined()
    const secondCall = active!.receivedMessages[1] as Array<{ content: unknown; tool_call_id?: string }> | undefined
    const toolMessage = secondCall!.find((m) => m.tool_call_id === 'call-commit-2')
    const toolText = JSON.stringify(toolMessage)
    expect(toolText).toContain('confirmation_required')
    expect(toolText).not.toContain('record_id')
  })

  it('审批恢复（resume 无 triggerMessageId）：从持久请求身份恢复且不受新消息影响，commit 仍可保存', async () => {
    const display = await seedAckedPresentation()
    const triggerId = await seedOwningMessage('就按这版保存')
    const models: ScriptedChatModel[] = []
    const confirming = createReflectionsRuntime(prisma, { classifier: async () => ({ decision: 'confirm' }) })
    const svc = makeService([
      toolCallAi('call-exec-1', 'execute', { command: 'echo hi' }),
      toolCallAi('call-commit-3', 'reflection_records', { operation: 'commit', draft_id: display.draftId, version: display.version }),
      new AIMessage('已保存。'),
    ], models, confirming.port, () => ({ tools: ['execute'] }))

    await svc.execute(cmd({ triggerMessageId: triggerId }))
    expect(svc.stateOf(sessionId)?.state).toBe('interrupted')
    expect(await prisma.reflectionRecord.count({ where: { ownerId: owner.id } })).toBe(0)

    // 即使持久历史出现更新消息，也不能把旧审批请求改绑到该消息。
    await seedOwningMessage('较新的无关消息，不能确认旧版本')
    const resume = svc.buildResumeCommand({
      sessionId,
      ownerId: owner.id,
      username: owner.username,
      decisions: { decisions: [{ type: 'approve' }] },
    })
    expect(resume.triggerMessageId).toBeUndefined()
    // RF19：丢弃图缓存/服务实例后，审批恢复只消费原授权，不重新批准。
    const recovered = createReflectionsRuntime(prisma, { classifier: async () => { throw new Error('恢复不能分类') } })
    const restarted = makeService([
      toolCallAi('call-commit-after-restart', 'reflection_records', { operation: 'commit', draft_id: display.draftId, version: display.version }),
      new AIMessage('恢复后已保存。'),
    ], [], recovered.port, () => ({ tools: ['execute'] }))
    try {
      await restarted.execute(resume)
      expect(await prisma.reflectionRecord.count({ where: { ownerId: owner.id } })).toBe(1)
    } finally { await restarted.dispose(); await recovered.dispose() }
  }, 30_000)
})
