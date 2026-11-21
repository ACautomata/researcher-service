// #1082（RF-T06）真实图接缝：新会话 Leader 按需检索正式记录、读取版本并在模型边界展开正文。
//
// 断言：只在相关任务调用；结果给 record_id/version；正文只在本次模型输入展开，持久消息只存引用；
// 旧经验作为证据而非系统指令；management 需真实用户管理意图。

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
import { sha256 } from '../src/reflections/content'
import { seedUser } from './helpers'
import { ScriptedChatModel, fakePrimitives, CollectingHub, toolCallAi, type ScriptEntry } from './runnerFakes'
import { installAbortRejectionGuard } from '../src/runner/runtime/abortGuard'

const LAB = 'researcher-sandbox-rfretr'
const WIKI = 'researcher-wiki-rfretr'
const BODY_TEXT = '文件写入后没有运行聚焦测试，导致构建回归反复出现。'

describe('#1082 反思记录按需检索：真实图 + 新会话', () => {
  let dir: string
  let prisma: PrismaClient
  let runtime: ReflectionsRuntime
  let owner: { id: string; username: string }
  let sessionId: string
  let turn: number
  let hub: CollectingHub

  beforeAll(async () => {
    installAbortRejectionGuard()
    dir = mkdtempSync(path.join(tmpdir(), `runner-1082-${process.pid}-`))
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    runtime = createReflectionsRuntime(prisma, { dbPath, cursorSweepMs: 0 })
    const user = await seedUser(prisma, 'rf-retr-owner', 'pw-rf-retr-secure')
    owner = { id: user.id, username: user.username }
    await prisma.modelProvider.create({
      data: { ownerId: user.id, providerId: 'prov-rf-retr', presetId: 'openai', modelsJson: JSON.stringify([{ id: 'model-rf-retr' }]) },
    })
    hub = new CollectingHub()
  }, 30_000)

  beforeEach(async () => {
    const session = await prisma.session.create({ data: { ownerId: owner.id, containerId: LAB, title: '检索图会话' } })
    sessionId = session.id
    turn = 100
  })

  afterAll(async () => {
    runtime.dispose()
    await prisma.$disconnect()
  })

  afterEach(async () => {
    await prisma.reflectionRequestBudget.deleteMany({})
    await prisma.reflectionRevision.deleteMany({})
    await prisma.reflectionRecord.deleteMany({})
    await prisma.session.deleteMany({ where: { id: sessionId } })
  })

  async function seedRecord(p: { title: string; problem?: string; status?: 'active' | 'inactive'; evidenceStatus?: 'valid' | 'review_required' }): Promise<string> {
    const body = {
      title: p.title,
      category: 'tool_use',
      problem: p.problem ?? BODY_TEXT,
      causes: [{ text: '缺少写后验证', kind: 'fact', evidence: [] }],
      improvements: ['遇到写文件后先运行聚焦测试'],
      scope: { labels: ['工具使用'], conditions: '涉及文件写入时', exclusions: '纯问答' },
    }
    const bodyJson = JSON.stringify({ ...body, evidence: [], version: 1, action: 'create' })
    const record = await prisma.reflectionRecord.create({
      data: {
        ownerId: owner.id,
        sessionId,
        title: body.title,
        category: body.category,
        contentJson: JSON.stringify(body),
        status: p.status ?? 'active',
        evidenceStatus: p.evidenceStatus ?? 'valid',
        currentRevision: 1,
      },
    })
    await prisma.reflectionRevision.create({
      data: { recordId: record.id, version: 1, bodyJson, bodyHash: sha256(bodyJson), evidenceJson: '[]' },
    })
    return record.id
  }

  function makeService(script: ScriptEntry[], models: ScriptedChatModel[]): RunService {
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
      reflections: runtime.port,
    })
  }

  async function seedUserMessage(content: string): Promise<string> {
    turn += 1
    const row = await prisma.sessionMessage.create({ data: { sessionId, turn, role: 'user', content } })
    return row.id
  }

  function cmd(triggerMessageId: string, content: string): RunCommand {
    return { runId: `run-${Math.random().toString(36).slice(2, 10)}`, sessionId, ownerId: owner.id, username: owner.username, kind: 'message', content, triggerMessageId }
  }

  it('新会话按需 search→read：显示 record_id/版本，正文只在模型输入展开', async () => {
    const recordId = await seedRecord({ title: '写后验证遗漏' })
    const trigger = await seedUserMessage('继续修复构建问题')
    const models: ScriptedChatModel[] = []
    const svc = makeService([
      toolCallAi('search-1', 'reflection_records', { operation: 'search', query: '构建 回归' }),
      toolCallAi('read-1', 'reflection_records', { operation: 'read', targets: [{ record_id: recordId }] }),
      new AIMessage('已参考记录并继续修复。'),
    ], models)
    await svc.execute(cmd(trigger, '继续修复构建问题'))

    const model = models.find((m) => m.invokeCount > 0)
    expect(model).toBeDefined()
    const calls = model!.receivedMessages
    const searchResult = JSON.stringify(calls[1])
    expect(searchResult).toContain(recordId)
    expect(searchResult).toContain('写后验证遗漏')
    // 读取后的模型输入（解引用后）才展开完整正文；工具输出本身只给引用。
    const expanded = JSON.stringify(calls[2])
    expect(expanded).toContain(BODY_TEXT)
    expect(expanded).toContain('【反思记录 v1】')
    expect(expanded).toContain(`记录ID：${recordId}`)

    expect(hub.types()).toContain('run.completed')
    // 展开字节实际计入主请求额度。
    const budget = await prisma.reflectionRequestBudget.findUnique({ where: { requestId: trigger } })
    expect(budget?.returnedBytes ?? 0).toBeGreaterThan(BODY_TEXT.length)
  }, 30_000)

  it('management 读取只由真实用户管理意图开启；普通任务被拒绝', async () => {
    const recordId = await seedRecord({ title: '停用经验', status: 'inactive' })
    const ordinary = await seedUserMessage('继续修复构建问题')
    const deniedModels: ScriptedChatModel[] = []
    const denied = makeService([
      toolCallAi('mgmt-1', 'reflection_records', { operation: 'read', purpose: 'management', targets: [{ record_id: recordId }] }),
      new AIMessage('管理读取被拒绝。'),
    ], deniedModels)
    await denied.execute(cmd(ordinary, '继续修复构建问题'))
    expect(JSON.stringify(deniedModels.find((m) => m.invokeCount > 0)!.receivedMessages)).toContain('confirmation_required')

    const trigger = await seedUserMessage('查看我的反思记录')
    const allowedModels: ScriptedChatModel[] = []
    const allowed = makeService([
      toolCallAi('mgmt-2', 'reflection_records', { operation: 'read', purpose: 'management', targets: [{ record_id: recordId }] }),
      new AIMessage('已查看管理视图。'),
    ], allowedModels)
    await allowed.execute(cmd(trigger, '查看我的反思记录'))
    const allowedModel = allowedModels.find((m) => m.invokeCount > 0)!
    const last = allowedModel.receivedMessages[allowedModel.receivedMessages.length - 1] as unknown as Array<{ tool_call_id?: string }>
    const toolResult = last.find((m) => m.tool_call_id === 'mgmt-2')
    expect(toolResult).toBeDefined()
    const toolText = JSON.stringify(toolResult)
    expect(toolText).not.toContain('confirmation_required')
    expect(toolText).toContain('停用经验')
    expect(toolText).toContain(BODY_TEXT)
  }, 30_000)
})
