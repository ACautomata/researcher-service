// figure_run 事件族（#792 · #744 §11.2 · S3 纯逻辑）：progress 白名单校验 + TextTrace
// 审计 sink 落库形状。验收「figure_run.progress 六 stage 落 SSE、其余五类落 TextTrace，
// 一次上报双面一致」的核心面在此锁定。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { parseFigureRunProgress, createPrismaFigureRunAuditSink, FIGURE_RUN_STAGES, FIGURE_RUN_PROGRESS } from '../src/figures/figureAudit'
import { createPrismaClient } from '../src/prisma'
import { seedUser } from './helpers'
import type { PrismaClient } from '../src/generated/prisma/client'

describe('parseFigureRunProgress（白名单校验）', () => {
  it('六 stage 逐一通过', () => {
    for (const stage of FIGURE_RUN_STAGES) {
      expect(parseFigureRunProgress({ stage })).toEqual({ stage })
    }
  })

  it('非六值 stage / 非对象 / 无 stage 一律丢弃（null）', () => {
    expect(parseFigureRunProgress({ stage: 'fabricating' })).toBeNull()
    expect(parseFigureRunProgress({ stage: 42 })).toBeNull()
    expect(parseFigureRunProgress({})).toBeNull()
    expect(parseFigureRunProgress('generating')).toBeNull()
    expect(parseFigureRunProgress(null)).toBeNull()
    expect(parseFigureRunProgress(undefined)).toBeNull()
  })

  it('事件名常量与 stage 枚举单源（核心定义、插件 re-export 消费）', () => {
    expect(FIGURE_RUN_PROGRESS).toBe('figure_run.progress')
    expect(FIGURE_RUN_STAGES).toEqual(['generating', 'segmenting', 'preparing', 'templating', 'assembling', 'rendering'])
  })
})

describe('createPrismaFigureRunAuditSink（TextTrace 五类审计）', () => {
  let prisma: PrismaClient
  let dir: string
  let ownerId: string

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'figure-audit-'))
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma, 'figure-audit-user', 'pw-figure-audit-secure')
    ownerId = user.id
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  function sink() {
    return createPrismaFigureRunAuditSink(prisma, { ownerId, username: 'alice', sessionId: 'sess-1', runId: 'run-1' })
  }

  async function drain(): Promise<void> {
    // fire-and-forget 落库——等一拍让 promise 链走完
    await new Promise((r) => setTimeout(r, 20))
  }

  it('created：inputText = methodText 截断，outputText 载荷含 event/toolCallId，status=success', async () => {
    sink().emitFigureRun({ event: 'created', toolCallId: 'tc1', detail: { methodText: '蛋白质折叠示意图' } })
    await drain()
    const row = await prisma.textTraceLog.findFirstOrThrow({ where: { runId: 'run-1' } })
    expect(row.sessionKey).toBe('sess-1')
    expect(row.userId).toBe(ownerId)
    expect(row.username).toBe('alice')
    expect(row.inputText).toBe('蛋白质折叠示意图')
    expect(row.status).toBe('success')
    const payload = JSON.parse(row.outputText) as Record<string, unknown>
    expect(payload.event).toBe('created')
    expect(payload.toolCallId).toBe('tc1')
    expect(row.traceId).not.toBe('')
  })

  it('stage_transitions / completed 落 success；failed / aborted 落 failed', async () => {
    const s = sink()
    s.emitFigureRun({ event: 'stage_transitions', toolCallId: 'tc1', detail: { to: 'generating' } })
    s.emitFigureRun({ event: 'completed', toolCallId: 'tc1', detail: { figureId: 'f1', iterations: 2, durationMs: 100 } })
    s.emitFigureRun({ event: 'failed', toolCallId: 'tc2', detail: { reason: 'fal API HTTP 500' } })
    s.emitFigureRun({ event: 'aborted', toolCallId: 'tc3', detail: { by: 'user' } })
    await drain()
    const rows = await prisma.textTraceLog.findMany({ where: { runId: 'run-1' }, orderBy: { createdAt: 'asc' } })
    const byEvent = new Map(rows.map((r) => [(JSON.parse(r.outputText) as Record<string, unknown>).event as string, r]))
    expect(byEvent.get('stage_transitions')!.status).toBe('success')
    expect(byEvent.get('completed')!.status).toBe('success')
    expect((JSON.parse(byEvent.get('completed')!.outputText) as Record<string, unknown>).figureId).toBe('f1')
    expect(byEvent.get('failed')!.status).toBe('failed')
    expect(byEvent.get('aborted')!.status).toBe('failed')
    // 非 created 事件 inputText 恒空
    expect(byEvent.get('completed')!.inputText).toBe('')
  })

  it('审计落库失败 fail-soft（不放大为调用方异常）', () => {
    // 外键违例（user 不存在）——fire-and-forget 面不得向调用方抛
    const broken = createPrismaFigureRunAuditSink(prisma, { ownerId: 'no-such-user', username: 'x', sessionId: 's', runId: 'r' })
    expect(() => broken.emitFigureRun({ event: 'created', toolCallId: 'tcX', detail: {} })).not.toThrow()
  })
})
