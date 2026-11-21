// #1082（RF-T06）反思记录检索、管理读取与按需复用验收：真实临时 SQLite + 真实只读执行器 + 业务口。
//
// 覆盖父规格 I3/I4/I6 的可观察行为：experience 仅 active+valid、NFKC/英文小写与 AND、
// 过滤交集与确定性页序、游标绑定/过期/版本变化 stale、read 目标顺序/完整性/安全错误、
// 主请求额度与查询槽、management 需可信管理意图且仅本人。

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { createReflectionsRuntime, type ReflectionsRuntime } from '../src/reflections/runtime'
import { sha256 } from '../src/reflections/content'
import type { ReflectionContext } from '../src/reflections/model'
import { seedUser } from './helpers'

const INIT_SQL = readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8')
const HISTORY_TRIGGERS_SQL = readFileSync(path.join(process.cwd(), 'prisma', 'history-triggers.sql'), 'utf8')

describe('#1082 reflections 记录检索（真实 SQLite + 真实只读执行器）', () => {
  let dir: string
  let dbPath: string
  let prisma: PrismaClient
  let runtime: ReflectionsRuntime
  let ownerId: string
  let sessionId: string
  let now: number

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), `panel-1082-${process.pid}-`))
    dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(INIT_SQL)
    sqlite.exec(HISTORY_TRIGGERS_SQL)
    sqlite.close()
    process.env.DATABASE_URL = `file:${dbPath}`
    process.env.NODE_ENV = 'test'
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma, 'rf-retrieval-owner', 'pw-rf-retrieval-secure')
    ownerId = user.id
    const session = await prisma.session.create({ data: { ownerId, containerId: 'researcher-sandbox-rfr', title: '检索会话' } })
    sessionId = session.id
    now = Date.parse('2026-11-21T02:00:00.000Z')
    runtime = createReflectionsRuntime(prisma, { dbPath, clock: () => now, cursorSweepMs: 0 })
  }, 30_000)

  afterEach(async () => {
    await prisma.reflectionIdempotency.deleteMany({})
    await prisma.reflectionGrant.deleteMany({})
    await prisma.reflectionRevision.deleteMany({})
    await prisma.reflectionRecord.deleteMany({})
    await prisma.reflectionPresentation.deleteMany({})
    await prisma.reflectionEvidence.deleteMany({})
    await prisma.reflectionDraft.deleteMany({})
    await prisma.reflectionEvent.deleteMany({})
    await prisma.reflectionRequestBudget.deleteMany({})
    await prisma.sessionMessage.deleteMany({ where: { sessionId } })
    now = Date.parse('2026-11-21T02:00:00.000Z')
  })

  afterAll(async () => {
    runtime?.dispose()
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  const leader = (extra: Partial<ReflectionContext> = {}): ReflectionContext => ({
    ownerId,
    currentSessionId: sessionId,
    role: 'leader',
    requestId: 'req-1082',
    ...extra,
  })

  let seedSeq = 0
  async function seedRecord(p: {
    title: string
    category?: string
    problem?: string
    improvements?: string[]
    labels?: string[]
    status?: 'active' | 'inactive' | 'superseded' | 'deleted'
    evidenceStatus?: 'valid' | 'review_required'
    updatedAt?: Date
  }): Promise<{ id: string; version: number }> {
    seedSeq += 1
    const body = {
      title: p.title,
      category: p.category ?? 'tool_use',
      problem: p.problem ?? '问题正文',
      causes: [{ text: '原因', kind: 'fact', evidence: [] }],
      improvements: p.improvements ?? ['改进建议'],
      scope: { labels: p.labels ?? [], conditions: '', exclusions: '' },
    }
    const bodyJson = JSON.stringify({ ...body, evidence: [], version: 1, action: 'create' })
    const updatedAt = p.updatedAt ?? new Date(Date.parse('2026-11-21T00:00:00.000Z') + seedSeq * 1000)
    const record = await prisma.reflectionRecord.create({
      data: {
        ownerId,
        sessionId,
        title: body.title,
        category: body.category,
        contentJson: JSON.stringify(body),
        status: p.status ?? 'active',
        evidenceStatus: p.evidenceStatus ?? 'valid',
        currentRevision: 1,
        updatedAt,
      },
    })
    await prisma.reflectionRevision.create({
      data: {
        recordId: record.id,
        version: 1,
        bodyJson,
        bodyHash: sha256(bodyJson),
        evidenceJson: JSON.stringify([{ position: 1, sessionId, messageId: 'm-1', runId: null, toolCallId: null, region: 'content', startCp: 0, endCp: 2, excerpt: '摘录', regionHash: null, contentVersion: null, status: 'valid' }]),
      },
    })
    return { id: record.id, version: 1 }
  }

  it('RF11：experience 只返回 active+valid 正式记录；草稿/停用/替代/待复核不进入', async () => {
    const active = await seedRecord({ title: '有效经验' })
    await prisma.reflectionDraft.create({
      data: { ownerId, sessionId, version: 1, status: 'pending', action: 'create', title: '有效经验', category: 'tool_use', contentJson: '{}' },
    })
    await seedRecord({ title: '停用经验', status: 'inactive' })
    await seedRecord({ title: '被替代经验', status: 'superseded' })
    await seedRecord({ title: '待复核经验', evidenceStatus: 'review_required' })

    const result = await runtime.service.execute(leader(), { operation: 'search' })
    expect(result.outcome, JSON.stringify(result)).toBe('success')
    expect(result.progress).toBe('complete')
    const records = result.records as Array<{ record_id: string }>
    expect(records.map((r) => r.record_id)).toEqual([active.id])
  })

  it('RF02：无 query 目录；NFKC/英文小写；空白切词 AND；category 与 scope 精确交集', async () => {
    const a = await seedRecord({ title: 'Fix Build Failure', problem: '构建失败后没有回归测试', labels: ['构建'] })
    const b = await seedRecord({ title: '另一个问题', problem: '构建很慢', labels: ['性能'], category: 'efficiency' })

    const catalog = await runtime.service.execute(leader(), { operation: 'search' })
    expect((catalog.records as unknown[]).length).toBe(2)

    // NFKC：全角字母归一；英文小写匹配。
    const nfkc = await runtime.service.execute(leader(), { operation: 'search', query: 'ｆｉｘ build' })
    expect((nfkc.records as Array<{ record_id: string }>).map((r) => r.record_id)).toEqual([a.id])

    // AND：两个词都必须命中（同一或不同字段）。
    const and = await runtime.service.execute(leader(), { operation: 'search', query: '构建 回归' })
    expect((and.records as Array<{ record_id: string }>).map((r) => r.record_id)).toEqual([a.id])

    // 过滤交集：category 与 scope 标签都必须满足。
    const filtered = await runtime.service.execute(leader(), { operation: 'search', category: 'efficiency', scope: ['性能'] })
    expect((filtered.records as Array<{ record_id: string }>).map((r) => r.record_id)).toEqual([b.id])
    const empty = await runtime.service.execute(leader(), { operation: 'search', category: 'efficiency', scope: ['构建'] })
    expect(empty.records).toEqual([])
    expect(empty.outcome).toBe('success')
  })

  it('RF02：query 1–256 码点；空白 query 明确报参数错误', async () => {
    const blank = await runtime.service.execute(leader(), { operation: 'search', query: '   ' })
    expect(blank.outcome).toBe('failure')
    expect(blank.error?.code).toBe('invalid_parameters')
    const long = await runtime.service.execute(leader(), { operation: 'search', query: '字'.repeat(257) })
    expect(long.error?.code).toBe('invalid_parameters')
  })

  it('RF02/RF16：确定性页序 updatedAt desc + id asc；20/50 条页；游标续读固定快照', async () => {
    const base = Date.parse('2026-11-21T01:00:00.000Z')
    const first = await seedRecord({ title: '第一条', updatedAt: new Date(base + 1000) })
    const second = await seedRecord({ title: '第二条', updatedAt: new Date(base + 2000) })
    const third = await seedRecord({ title: '第三条', updatedAt: new Date(base + 3000) })

    const page1 = await runtime.service.execute(leader(), { operation: 'search', limit: 2 })
    expect(page1.progress).toBe('more')
    expect((page1.records as Array<{ record_id: string }>).map((r) => r.record_id)).toEqual([third.id, second.id])
    expect(page1.cursor).toEqual(expect.any(String))

    // 追加新行不混入已固定快照。
    const later = await seedRecord({ title: '后来的记录', updatedAt: new Date(base + 9000) })
    const page2 = await runtime.service.execute(leader(), { operation: 'search', limit: 2, cursor: page1.cursor })
    expect(page2.progress).toBe('complete')
    expect((page2.records as Array<{ record_id: string }>).map((r) => r.record_id)).toEqual([first.id])
    expect((page2.records as Array<{ record_id: string }>).map((r) => r.record_id)).not.toContain(later.id)
  })

  it('RF16：游标绑定 owner/purpose/条件；过期后 cursor_stale；重启旧游标失效', async () => {
    await seedRecord({ title: '一' })
    await seedRecord({ title: '二' })
    const page1 = await runtime.service.execute(leader(), { operation: 'search', limit: 1 })

    const wrongPurpose = await runtime.service.execute(leader({ managementIntent: true }), { operation: 'search', limit: 1, purpose: 'management', cursor: page1.cursor })
    expect(wrongPurpose.error?.code, JSON.stringify(wrongPurpose)).toBe('cursor_stale')

    const other = await prisma.user.create({ data: { id: 'rf-other-owner', username: 'rf-other' } })
    const otherContext: ReflectionContext = { ownerId: other.id, currentSessionId: 'other-session', role: 'leader', requestId: 'req-other' }
    const crossOwner = await runtime.service.execute(otherContext, { operation: 'search', limit: 1, cursor: page1.cursor })
    expect(crossOwner.error?.code).toBe('cursor_stale')

    now += 10 * 60_000 + 1
    const expired = await runtime.service.execute(leader(), { operation: 'search', limit: 1, cursor: page1.cursor })
    expect(expired.error?.code).toBe('cursor_stale')

    // 重启：内存游标不跨服务实例。
    now = Date.parse('2026-11-21T02:00:00.000Z')
    await seedRecord({ title: '三' })
    const freshPage = await runtime.service.execute(leader(), { operation: 'search', limit: 1 })
    const restarted = createReflectionsRuntime(prisma, { dbPath, clock: () => now, cursorSweepMs: 0 })
    try {
      const stale = await restarted.service.execute(leader(), { operation: 'search', limit: 1, cursor: freshPage.cursor })
      expect(stale.error?.code).toBe('cursor_stale')
    } finally {
      restarted.dispose()
    }
  })

  it('RF16：快照内记录内容/证据版本变化 → cursor_stale 并指引重查，不混新旧结果', async () => {
    const base = Date.parse('2026-11-21T01:00:00.000Z')
    const first = await seedRecord({ title: '一', updatedAt: new Date(base + 1000) })
    await seedRecord({ title: '二', updatedAt: new Date(base + 2000) })
    const page1 = await runtime.service.execute(leader(), { operation: 'search', limit: 1 })
    expect(page1.progress).toBe('more')
    // 快照内下一条（first，page1 未被返回）发生版本变化。
    await prisma.reflectionRecord.update({ where: { id: first.id }, data: { currentRevision: 2, evidenceStatus: 'review_required', updatedAt: new Date(base + 5000) } })
    const page2 = await runtime.service.execute(leader(), { operation: 'search', limit: 1, cursor: page1.cursor })
    expect(page2.outcome, JSON.stringify(page2)).toBe('failure')
    expect(page2.error?.code).toBe('cursor_stale')
    expect(String(page2.guidance)).toContain('重查')
  })

  it('RF11/RF21：read 按输入顺序给完整性、出处与 body_ref；版本冲突与不存在安全同形', async () => {
    const first = await seedRecord({ title: '第一条' })
    const second = await seedRecord({ title: '第二条' })
    const read = await runtime.service.execute(leader(), {
      operation: 'read',
      targets: [{ record_id: second.id }, { record_id: first.id }],
    })
    expect(read.outcome).toBe('success')
    expect(read.progress).toBe('complete')
    const records = read.records as Array<{ record_id: string; version: number; body_ref: string; evidence: Array<{ position: number; status: string }> }>
    expect(records.map((r) => r.record_id)).toEqual([second.id, first.id])
    expect(records[0].version).toBe(1)
    expect(records[0].body_ref).toBe(`reflection_record:${second.id}:1`)
    expect(records[0].evidence[0].status).toBe('valid')

    const conflict = await runtime.service.execute(leader(), {
      operation: 'read',
      targets: [{ record_id: first.id, version: 9 }],
    })
    expect(conflict.outcome).toBe('partial_success')
    expect((conflict.records as Array<{ status: string }>)[0].status).toBe('conflict')

    const missing = await runtime.service.execute(leader(), { operation: 'read', targets: [{ record_id: 'does-not-exist' }] })
    expect((missing.records as Array<{ status: string }>)[0].status).toBe('not_found')
  })

  it('RF11：read 不泄露不可主动使用的记录正文；management 才可读取状态', async () => {
    const inactive = await seedRecord({ title: '停用经验', status: 'inactive' })
    const experience = await runtime.service.execute(leader(), { operation: 'read', targets: [{ record_id: inactive.id }] })
    expect(experience.outcome).toBe('partial_success')
    expect((experience.records as Array<{ status: string; body_ref?: string }>)[0].status).toBe('not_found')
    expect((experience.records as Array<{ body_ref?: string }>)[0].body_ref).toBeUndefined()

    const noIntent = await runtime.service.execute(leader(), { operation: 'read', purpose: 'management', targets: [{ record_id: inactive.id }] })
    expect(noIntent.outcome).toBe('failure')
    expect(noIntent.error?.code).toBe('confirmation_required')

    const management = await runtime.service.execute(leader({ managementIntent: true }), {
      operation: 'read', purpose: 'management', targets: [{ record_id: inactive.id }],
    })
    expect(management.outcome).toBe('success')
    const row = (management.records as Array<{ status: string; record_status?: string; body_ref: string }>)[0]
    expect((row as { record_status?: string }).record_status).toBe('inactive')
    expect(row.body_ref).toBe(`reflection_record:${inactive.id}:1`)
  })

  it('RF11：management 需可信管理意图；仅本人；草稿单独 state', async () => {
    await seedRecord({ title: '停用经验', status: 'inactive' })
    const denied = await runtime.service.execute(leader(), { operation: 'search', purpose: 'management' })
    expect(denied.outcome).toBe('failure')
    expect(denied.error?.code).toBe('confirmation_required')

    const allowed = await runtime.service.execute(leader({ managementIntent: true }), { operation: 'search', purpose: 'management' })
    expect(allowed.outcome).toBe('success')
    expect((allowed.records as unknown[]).length).toBe(1)

    const states = await runtime.service.execute(leader({ managementIntent: true }), { operation: 'search', purpose: 'management', state: 'inactive' })
    expect((states.records as unknown[]).length).toBe(1)

    // 未确认草稿只以 draft_state 单独列出。
    await prisma.reflectionDraft.create({
      data: { ownerId, sessionId, version: 1, status: 'pending', action: 'create', title: '草稿', category: 'other', contentJson: '{}' },
    })
    const drafts = await runtime.service.execute(leader({ managementIntent: true }), { operation: 'search', purpose: 'management', draft_state: 'pending' })
    expect((drafts.drafts as unknown[]).length).toBe(1)
    expect(drafts.records).toEqual([])

    const other = await prisma.user.create({ data: { id: 'rf-other-management', username: 'rf-other-mgmt' } })
    const otherContext: ReflectionContext = { ownerId: other.id, currentSessionId: 'other-session-2', role: 'leader', requestId: 'req-other-2', managementIntent: true }
    const crossUser = await runtime.service.execute(otherContext, { operation: 'search', purpose: 'management' })
    expect(crossUser.records).toEqual([])
  })

  it('RF17：每主请求独立额度（次数/字节/等待）；超限 stopped；缺可信请求身份停止', async () => {
    await seedRecord({ title: '额度测试' })
    const limited = createReflectionsRuntime(prisma, {
      dbPath,
      clock: () => now,
      cursorSweepMs: 0,
      budgetLimits: { calls: 1, waitMs: 10_000, bytes: 256 * 1024 },
    })
    try {
      const first = await limited.service.execute(leader(), { operation: 'search' })
      expect(first.outcome).toBe('success')
      const second = await limited.service.execute(leader(), { operation: 'search' })
      expect(second.outcome).toBe('failure')
      expect(second.error?.category).toBe('limit')
      expect(second.progress).toBe('stopped')
    } finally {
      limited.dispose()
    }

    const noIdentity = await runtime.service.execute({ ...leader(), requestId: undefined }, { operation: 'search' })
    expect(noIdentity.outcome).toBe('failure')
    expect(noIdentity.progress).toBe('stopped')
  })

  it('RF17：单次字节上限不足时明确 partial/stopped，不报空结果', async () => {
    await seedRecord({ title: '很长的记录一', problem: '正文'.repeat(500) })
    await seedRecord({ title: '很长的记录二', problem: '正文'.repeat(500) })
    const tiny = createReflectionsRuntime(prisma, {
      dbPath,
      clock: () => now,
      cursorSweepMs: 0,
      budgetLimits: { calls: 20, waitMs: 10_000, bytes: 256 * 1024 },
      perCallBytes: 200,
    })
    try {
      const result = await tiny.service.execute(leader(), { operation: 'search' })
      expect(result.progress).toBe('stopped')
      expect(result.outcome).toBe('partial_success')
      expect((result.records as unknown[]).length).toBeGreaterThan(0)
      expect(result.error?.category).toBe('limit')
    } finally {
      tiny.dispose()
    }
  })

  it('RF17：查询执行槽每用户 1、全局 4；满额立即 busy；取消真实释放', async () => {
    const lease = await runtime.query!.lease(ownerId)
    expect(lease).toBeDefined()
    expect(await runtime.query!.lease(ownerId)).toBeUndefined()
    const busy = await runtime.service.execute(leader(), { operation: 'search' })
    expect(busy.outcome).toBe('failure')
    expect(busy.error?.code).toBe('busy')
    lease!.release()
    const released = await runtime.query!.lease(ownerId)
    expect(released).toBeDefined()
    released!.release()
  })

  it('RF16：续读不延长游标绝对到期', async () => {
    const base = Date.parse('2026-11-21T01:00:00.000Z')
    const first = await seedRecord({ title: '一', updatedAt: new Date(base + 1000) })
    const second = await seedRecord({ title: '二', updatedAt: new Date(base + 2000) })
    await seedRecord({ title: '三', updatedAt: new Date(base + 3000) })
    const page1 = await runtime.service.execute(leader(), { operation: 'search', limit: 1 })
    expect(page1.progress).toBe('more')
    now += 5 * 60_000
    const page2 = await runtime.service.execute(leader(), { operation: 'search', limit: 1, cursor: page1.cursor })
    expect(page2.outcome, JSON.stringify(page2)).toBe('success')
    expect((page2.records as Array<{ record_id: string }>).map((r) => r.record_id)).toEqual([second.id])
    expect(page2.cursor).toEqual(expect.any(String))
    // 续读不延长绝对到期。
    expect(page1.cursor_expires_at).toEqual(expect.any(String))
    expect(page2.cursor_expires_at).toEqual(page1.cursor_expires_at)
    now += 5 * 60_000 + 1
    const page3 = await runtime.service.execute(leader(), { operation: 'search', limit: 1, cursor: page2.cursor })
    expect(page3.error?.code).toBe('cursor_stale')
    expect((page1.records as Array<{ record_id: string }>).length).toBe(1)
    expect(first.id).toBeTruthy()
  })

  it('RF16：每用户游标容量 4；超限明确 busy，不裁掉已有游标', async () => {
    await seedRecord({ title: '一' })
    await seedRecord({ title: '二' })
    const cursors: Array<string | undefined> = []
    for (let i = 0; i < 4; i++) {
      const page = await runtime.service.execute(leader(), { operation: 'search', limit: 1 })
      expect(page.outcome, JSON.stringify(page)).toBe('success')
      cursors.push(page.cursor)
    }
    expect(cursors.every((c) => typeof c === 'string')).toBe(true)
    const fifth = await runtime.service.execute(leader(), { operation: 'search', limit: 1 })
    expect(fifth.outcome).toBe('partial_success')
    expect(fifth.error?.code).toBe('busy')
    // 已发出的游标仍可用（不裁已有集合）。
    const stillWorks = await runtime.service.execute(leader(), { operation: 'search', limit: 1, cursor: cursors[0] })
    expect(stillWorks.outcome, JSON.stringify(stillWorks)).toBe('success')
  })

  it('RF01：非 Leader 角色拒绝记录检索；schema 拒绝身份覆盖字段', async () => {
    for (const role of ['teammate', 'wiki-update', 'subagent'] as const) {
      const result = await runtime.service.execute({ ownerId, currentSessionId: sessionId, role, requestId: 'req-1082' }, { operation: 'search' })
      expect(result.error?.code).toBe('leader_only')
    }
    const override = await runtime.service.execute(leader(), { operation: 'search', ownerId: 'someone-else' })
    expect(override.error?.code).toBe('invalid_parameters')
    const empty = await runtime.service.execute(leader(), { operation: 'search', query: '不存在的关键词' })
    expect(empty.outcome).toBe('success')
    expect(empty.records).toEqual([])
  })

  it('RF16/RF17：真实执行器硬终止后续查询可复用；取消路径实际终止', async () => {
    const started = Date.now()
    await expect(runtime.query!.probeBusy(60_000, { cooperativeMs: 60_000, hardMs: 1_000 })).rejects.toBeDefined()
    expect(Date.now() - started).toBeLessThan(15_000)
    const after = await runtime.service.execute(leader(), { operation: 'search' })
    expect(after.outcome, JSON.stringify(after)).toBe('success')

    const controller = new AbortController()
    const pending = runtime.query!.probeBusy(30_000, { cooperativeMs: 30_000, hardMs: 20_000, signal: controller.signal })
      .then(() => 'resolved' as const, (error: unknown) => error)
    setTimeout(() => controller.abort(), 100)
    expect(await pending).toBeInstanceOf(Error)
    expect((await runtime.service.execute(leader(), { operation: 'search' })).outcome).toBe('success')
  }, 30_000)
})
