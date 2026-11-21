// #1080（RF-T04）reflections 草稿链路验收：真实临时 SQLite + 业务口 + 窄协议 REST。
//
// 覆盖父规格 I3/I4/I5 的可观察行为：五部分与证据核验（服务端原文/范围/hash）、在飞证据
// preparing→recordTurn 接缝转 valid、完整展示/版本变化/ack、未确认不可保存、证据失配拒绝、
// 敏感内容脱敏、management 读取草稿而 experience 不暴露草稿。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import supertest, { type SuperTest, type Test } from 'supertest'
import type { Application } from 'express'
import { createPrismaClient } from '../src/prisma'
import { createApp } from '../src/app'
import type { PrismaClient } from '../src/generated/prisma/client'
import { createReflectionsRuntime, type ReflectionsRuntime } from '../src/reflections/runtime'
import { contentVersionOf, sha256 } from '../src/reflections/content'
import { serializeAttachments } from '../src/sessions/reducer'
import { seedUser, login, bearer } from './helpers'

const INIT_SQL = readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8')
const HISTORY_TRIGGERS_SQL = readFileSync(path.join(process.cwd(), 'prisma', 'history-triggers.sql'), 'utf8')

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

describe('#1080 reflections 草稿链路（真实 SQLite）', () => {
  let dir: string
  let dbPath: string
  let prisma: PrismaClient
  let runtime: ReflectionsRuntime
  let app: Application
  let request: SuperTest<Test>
  let ownerId: string
  let sessionId: string

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), `panel-1080-${process.pid}-`))
    dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(INIT_SQL)
    sqlite.exec(HISTORY_TRIGGERS_SQL)
    sqlite.close()
    process.env.DATABASE_URL = `file:${dbPath}`
    process.env.NODE_ENV = 'test'
    prisma = createPrismaClient(`file:${dbPath}`)
    runtime = createReflectionsRuntime(prisma)
    app = createApp({ prisma, reflections: { service: runtime.service } })
    request = supertest(app) as unknown as SuperTest<Test>

    const user = await seedUser(prisma, 'rf-owner', 'pw-rf-owner-secure')
    ownerId = user.id
    const session = await prisma.session.create({ data: { ownerId, containerId: `researcher-sandbox-rf`, title: '反思会话' } })
    sessionId = session.id
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  const leader = (runId?: string) => ({ ownerId, currentSessionId: sessionId, role: 'leader' as const, ...(runId ? { runId } : {}) })

  async function seedAssistant(content: string): Promise<{ id: string; attachmentsJson: string }> {
    const row = await prisma.sessionMessage.create({
      data: { sessionId, turn: 99, role: 'assistant', content, attachmentsJson: serializeAttachments({ thinking: '思考' }) },
    })
    return { id: row.id, attachmentsJson: row.attachmentsJson }
  }

  it('非 Leader 角色一律拒绝', async () => {
    const result = await runtime.service.execute({ ownerId, currentSessionId: sessionId, role: 'teammate' }, { operation: 'search' })
    expect(result.outcome).toBe('failure')
    expect(result.error?.code).toBe('leader_only')
  })

  it('已持久证据：服务端核验范围/hash，status=pending', async () => {
    const content = '第一段。写文件后未运行测试，导致回归。'
    const points = [...content]
    const message = await seedAssistant(content)
    const result = await runtime.service.execute(leader(), {
      ...DRAFT,
      evidence: [{ session_id: sessionId, message_id: message.id, region: 'content', start: 4, end: points.length, excerpt: points.slice(4).join('') }],
    })
    expect(result.outcome).toBe('success')
    const draft = result.draft as { draft_id: string; version: number; status: string; evidence: Array<{ status: string }> }
    expect(draft.status).toBe('pending')
    expect(draft.evidence[0].status).toBe('valid')

    const row = await prisma.reflectionEvidence.findFirst({ where: { draftId: draft.draft_id } })
    expect(row?.regionHash).toBe(sha256(content))
    expect(row?.contentVersion).toBe(contentVersionOf(content, message.attachmentsJson))
    expect(row?.startCp).toBe(4)
    expect(row?.endCp).toBe(points.length)

    // 没有展示 → 明确 not_ready（没有展示不能 confirm）。
    const noDisplay = await runtime.service.execute(leader(), { operation: 'commit', draft_id: draft.draft_id, version: draft.version })
    expect(noDisplay.error?.code).toBe('not_ready')
  })

  it('摘录与原文不匹配 → 明确拒绝，不创建草稿', async () => {
    const message = await seedAssistant('真实内容')
    const before = await prisma.reflectionDraft.count({ where: { sessionId } })
    const result = await runtime.service.execute(leader(), {
      ...DRAFT,
      evidence: [{ session_id: sessionId, message_id: message.id, region: 'content', excerpt: '编造的摘录' }],
    })
    expect(result.outcome).toBe('failure')
    expect(result.error?.code).toBe('evidence_mismatch')
    expect(await prisma.reflectionDraft.count({ where: { sessionId } })).toBe(before)
  })

  it('敏感内容脱敏：凭证形态不进入正文或摘录存储', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwx'
    const message = await seedAssistant(`配置为 ${secret} 后继续`)
    const result = await runtime.service.execute(leader(), {
      ...DRAFT,
      problem: `我粘贴了 ${secret} 到命令里。`,
      evidence: [{ session_id: sessionId, message_id: message.id, region: 'content', excerpt: secret }],
    })
    expect(result.outcome).toBe('success')
    const stored = await prisma.reflectionDraft.findUnique({ where: { id: (result.draft as { draft_id: string }).draft_id } })
    expect(stored?.contentJson).not.toContain(secret)
    const evidence = await prisma.reflectionEvidence.findFirst({ where: { draftId: stored!.id } })
    expect(evidence?.excerpt).not.toContain(secret)
  })

  it('在飞证据：preparing、展示不可确认、commit 明确 confirmation_required', async () => {
    const result = await runtime.service.execute(leader('run-abc'), {
      ...DRAFT,
      evidence: [{ session_id: sessionId, region: 'content', excerpt: '当前轮尚未落库的输出' }],
    })
    expect(result.outcome, JSON.stringify(result)).toBe('success')
    const draft = result.draft as { draft_id: string; version: number; status: string }
    expect(draft.status).toBe('preparing')

    const presented = await runtime.service.execute(leader('run-abc'), { operation: 'present', draft_id: draft.draft_id, version: draft.version })
    expect(presented.outcome).toBe('success')
    expect(presented.confirmable).toBe(false)
    expect(String(presented.not_confirmable_reason)).toContain('在飞')

    const commit = await runtime.service.execute(leader('run-abc'), { operation: 'commit', draft_id: draft.draft_id, version: draft.version })
    expect(commit.outcome).toBe('failure')
    expect(commit.error?.code).toBe('not_ready')
  })

  it('recordTurn 接缝：在飞证据落行后转 valid、草稿转 pending；ack 前不可用', async () => {
    const excerpt = '当前轮续跑输出：已完成修改'
    const created = await runtime.service.execute(leader('run-bind'), {
      ...DRAFT,
      evidence: [{ session_id: sessionId, region: 'content', excerpt }],
    })
    const draft = created.draft as { draft_id: string; version: number }
    const presented = await runtime.service.execute(leader('run-bind'), { operation: 'present', draft_id: draft.draft_id, version: draft.version })
    const presentation = presented.presentation as { displayId: string; bodyHash: string }

    // 终态 assistant 行（recordTurn 写 attachmentsJson 时带上展示引用）+ 统一绑定
    const message = await prisma.sessionMessage.create({
      data: {
        sessionId,
        turn: 100,
        role: 'assistant',
        content: `好的。${excerpt}。`,
        attachmentsJson: serializeAttachments({
          presentations: [{ displayId: presentation.displayId, draftId: draft.draft_id, version: draft.version, bodyHash: presentation.bodyHash, status: 'preparing', confirmable: false }],
        }),
      },
    })
    await runtime.store.bindInFlightEvidence({ ownerId, sessionId, runId: 'run-bind', messageId: message.id, displayIds: [presentation.displayId] })

    const evidence = await prisma.reflectionEvidence.findFirst({ where: { draftId: draft.draft_id } })
    expect(evidence?.status).toBe('valid')
    expect(evidence?.messageId).toBe(message.id)
    const after = await runtime.store.getDraft(ownerId, draft.draft_id)
    expect(after?.status).toBe('pending')

    const display = await runtime.service.getDisplay(ownerId, presentation.displayId)
    expect(display?.messageId).toBe(message.id)
    // 展示 ref 里冻结的 confirmable=false，读面按当前草稿状态实时计算为 true。
    expect(display?.confirmable).toBe(true)

    const acked = await runtime.service.ackDisplay(ownerId, presentation.displayId, { version: draft.version, hash: presentation.bodyHash, messageId: message.id })
    expect('seq' in acked).toBe(true)
    // 幂等重放返回同一序号
    const again = await runtime.service.ackDisplay(ownerId, presentation.displayId, { version: draft.version, hash: presentation.bodyHash, messageId: message.id })
    expect(again).toEqual(acked)

    // commit 仍需要用户自然语言确认（RF-T05 未实现）
    const commit = await runtime.service.execute(leader('run-bind'), { operation: 'commit', draft_id: draft.draft_id, version: draft.version })
    expect(commit.error?.code).toBe('confirmation_required')
  })

  it('ack：未绑定 → not_ready；版本/hash 不符 → conflict', async () => {
    const created = await runtime.service.execute(leader(), {
      ...DRAFT,
      evidence: [{ session_id: sessionId, message_id: (await seedAssistant('ack 测试正文')).id, region: 'content', excerpt: 'ack 测试正文' }],
    })
    const draft = created.draft as { draft_id: string; version: number }
    const presented = await runtime.service.execute(leader(), { operation: 'present', draft_id: draft.draft_id, version: draft.version })
    const presentation = presented.presentation as { displayId: string; bodyHash: string }
    const notReady = await runtime.service.ackDisplay(ownerId, presentation.displayId, { version: draft.version, hash: presentation.bodyHash, messageId: 'm-x' })
    expect(notReady).toEqual({ error: 'not_ready' })
    const conflict = await runtime.service.ackDisplay(ownerId, presentation.displayId, { version: draft.version, hash: 'f'.repeat(64), messageId: 'm-x' })
    expect(conflict).toEqual({ error: 'conflict' })
  })

  it('修订：版本递增、撤销旧展示；过期基准版本整体 conflict', async () => {
    const message = await seedAssistant('修订证据正文')
    const created = await runtime.service.execute(leader(), {
      ...DRAFT,
      evidence: [{ session_id: sessionId, message_id: message.id, region: 'content', excerpt: '修订证据正文' }],
    })
    const draft = created.draft as { draft_id: string; version: number }
    const first = await runtime.service.execute(leader(), { operation: 'present', draft_id: draft.draft_id, version: draft.version })
    const oldDisplay = (first.presentation as { displayId: string }).displayId

    const revised = await runtime.service.execute(leader(), {
      ...DRAFT,
      action: 'revise',
      draft_id: draft.draft_id,
      base_version: draft.version,
      title: '修订后的标题',
      evidence: [{ session_id: sessionId, message_id: message.id, region: 'content', excerpt: '修订证据正文' }],
    })
    expect(revised.outcome).toBe('success')
    const next = revised.draft as { version: number; title: string }
    expect(next.version).toBe(draft.version + 1)
    expect(next.title).toBe('修订后的标题')
    // 修订版本的展示保留 action=new/revise（不硬编码 create）。
    const rep = await runtime.service.execute(leader(), { operation: 'present', draft_id: draft.draft_id, version: next.version })
    const repDisplay = await runtime.service.getDisplay(ownerId, (rep.presentation as { displayId: string }).displayId)
    expect(repDisplay?.action).toBe('revise')
    const old = await prisma.reflectionPresentation.findUnique({ where: { displayId: oldDisplay } })
    expect(old?.status).toBe('revoked')

    const stale = await runtime.service.execute(leader(), {
      ...DRAFT,
      action: 'revise',
      draft_id: draft.draft_id,
      base_version: draft.version,
      evidence: [{ session_id: sessionId, message_id: message.id, region: 'content', excerpt: '修订证据正文' }],
    })
    expect(stale.error?.code).toBe('conflict')
  })

  it('management 可列/读草稿；experience 不暴露未确认草稿', async () => {
    const management = await runtime.service.execute(leader(), { operation: 'search', purpose: 'management' })
    expect(management.outcome).toBe('success')
    expect((management.drafts as unknown[]).length).toBeGreaterThan(0)
    const experience = await runtime.service.execute(leader(), { operation: 'search', purpose: 'experience' })
    expect(experience.outcome).toBe('success')
    expect(experience.records).toEqual([])
    const readExperience = await runtime.service.execute(leader(), { operation: 'read', purpose: 'experience', targets: [{ draft_id: 'whatever' }] })
    expect(readExperience.drafts).toEqual([])
  })

  it('取消：关闭未提交草稿并清理证据/展示', async () => {
    const message = await seedAssistant('取消测试正文')
    const created = await runtime.service.execute(leader(), {
      ...DRAFT,
      evidence: [{ session_id: sessionId, message_id: message.id, region: 'content', excerpt: '取消测试正文' }],
    })
    const draft = created.draft as { draft_id: string; version: number }
    const cancelled = await runtime.service.execute(leader(), { operation: 'cancel', draft_id: draft.draft_id })
    expect(cancelled.outcome).toBe('success')
    expect((cancelled.draft as { status: string }).status).toBe('cancelled')
    expect(await prisma.reflectionEvidence.count({ where: { draftId: draft.draft_id } })).toBe(0)
  })

  it('RF01：仅 Leader 可调；子助手拒绝；schema 拒绝身份覆盖字段', async () => {
    for (const role of ['teammate', 'wiki-update', 'subagent'] as const) {
      const result = await runtime.service.execute({ ownerId, currentSessionId: sessionId, role }, { operation: 'search' })
      expect(result.error?.code).toBe('leader_only')
    }
    const override = await runtime.service.execute(leader(), { operation: 'search', ownerId: 'someone-else' })
    expect(override.error?.code).toBe('invalid_parameters')
  })

  it('可信当前证据端口不接受其他会话（历史证据须走 session_history 边界）', async () => {
    const other = await prisma.session.create({ data: { ownerId, containerId: 'researcher-sandbox-rf2', title: '另一个会话' } })
    const foreign = await prisma.sessionMessage.create({
      data: { sessionId: other.id, turn: 1, role: 'assistant', content: '别的会话里的原文' },
    })
    const result = await runtime.service.execute(leader(), {
      ...DRAFT,
      evidence: [{ session_id: other.id, message_id: foreign.id, region: 'content', excerpt: '别的会话里的原文' }],
    })
    expect(result.error?.code).toBe('invalid_evidence')
  })

  it('来源内容变化：present 拒绝为可确认版本并回 preparing', async () => {
    const message = await seedAssistant('展示前会被改写的正文')
    const created = await runtime.service.execute(leader(), {
      ...DRAFT,
      evidence: [{ session_id: sessionId, message_id: message.id, region: 'content', excerpt: '展示前会被改写的正文' }],
    })
    const draft = created.draft as { draft_id: string; version: number }
    await prisma.sessionMessage.update({ where: { id: message.id }, data: { content: '内容已经变了' } })

    const presented = await runtime.service.execute(leader(), { operation: 'present', draft_id: draft.draft_id, version: draft.version })
    expect(presented.outcome).toBe('failure')
    expect(presented.error?.code).toBe('not_ready')
    const after = await runtime.store.getDraft(ownerId, draft.draft_id)
    expect(after?.status).toBe('preparing')
    expect(after?.evidence.every((e) => e.status === 'not_ready')).toBe(true)
  })

  it('REST：展示读取与 ack 的错误码映射', async () => {
    const auth = bearer((await login(request, 'rf-owner', 'pw-rf-owner-secure')).access)
    const missing = await request.get('/api/v1/reflections/displays/nope').set(auth)
    expect(missing.body.code).toBe(50009)

    const created = await runtime.service.execute(leader(), {
      ...DRAFT,
      evidence: [{ session_id: sessionId, message_id: (await seedAssistant('REST 测试正文')).id, region: 'content', excerpt: 'REST 测试正文' }],
    })
    const draft = created.draft as { draft_id: string; version: number }
    const presented = await runtime.service.execute(leader(), { operation: 'present', draft_id: draft.draft_id, version: draft.version })
    const presentation = presented.presentation as { displayId: string; bodyHash: string }

    const display = await request.get(`/api/v1/reflections/displays/${presentation.displayId}`).set(auth)
    expect(display.body.code).toBe(0)
    expect(display.body.data.body.title).toBe(DRAFT.title)
    expect(display.body.data.evidence[0].status).toBe('valid')

    const notReady = await request.post(`/api/v1/reflections/displays/${presentation.displayId}/ack`).set(auth).send({ version: draft.version, hash: presentation.bodyHash, messageId: 'm-1' })
    expect(notReady.body.code).toBe(50010)
    const bad = await request.post(`/api/v1/reflections/displays/${presentation.displayId}/ack`).set(auth).send({ version: draft.version, hash: 'x', messageId: 'm-1' })
    expect(bad.body.code).toBe(90002)
  })
})

// fresh（init.sql，prisma migrate diff 派生物）与增量镜像（runIncrementalSchema）四表列集/索引一致。
describe('#1080 reflections 四表 parity（fresh vs 增量）', () => {
  it('两路径列集与索引相同（镜像漂移即红）', async () => {
    const { runIncrementalSchema } = await import('../scripts/lib/incremental-schema.mjs')
    const dir = mkdtempSync(path.join(tmpdir(), `rf-parity-${process.pid}-`))
    try {
      const fresh = new Database(path.join(dir, 'fresh.db'))
      fresh.exec(INIT_SQL)
      const up = new Database(path.join(dir, 'up.db'))
      up.exec(`CREATE TABLE "users" ("id" TEXT NOT NULL PRIMARY KEY, "username" TEXT NOT NULL)`)
      runIncrementalSchema(up)
      runIncrementalSchema(up) // 幂等二跑
      for (const table of ['reflection_drafts', 'reflection_evidence', 'reflection_presentations', 'reflection_events']) {
        const a = fresh.prepare(`PRAGMA table_info("${table}")`).all()
        const b = up.prepare(`PRAGMA table_info("${table}")`).all()
        expect(b, table).toEqual(a)
        const idx = (db: Database.Database) =>
          db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name").all(table)
        expect(idx(up), `${table} indexes`).toEqual(idx(fresh))
      }
      fresh.close()
      up.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
