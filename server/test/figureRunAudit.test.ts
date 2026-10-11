// 插件 run 事件族（#792 · #744 §11.2 · #853 §3.2#5/#6 泛化 · S3 纯逻辑）：progress 白名单
// 校验 + TextTrace 审计 sink 落库形状。验收「`<kind>_run.progress` 白名单 stage 落 SSE、
// 其余五类落 TextTrace，一次上报双面一致」的核心面在此锁定——figure 族行为零变（声明
// 迁移后）+ runKind 盖章契约。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
  parsePluginRunProgress,
  createPrismaPluginRunAuditSink,
  pluginRunProgressEventName,
  FROZEN_RUN_KIND,
  FIGURE_RUN_STAGES,
  FIGURE_RUN_PROGRESS,
} from '../src/figures/figureAudit'
import { createPrismaClient } from '../src/prisma'
import { seedUser } from './helpers'
import type { PrismaClient } from '../src/generated/prisma/client'

describe('parsePluginRunProgress（白名单校验，#853 §3.2#6 泛化签名）', () => {
  const stages = new Set<string>(FIGURE_RUN_STAGES)

  it('figure 六 stage 逐一通过（声明迁移后行为零变）', () => {
    for (const stage of FIGURE_RUN_STAGES) {
      expect(parsePluginRunProgress({ stage }, stages)).toMatchObject({ stage })
    }
  })

  it('白名单外 stage / 非对象 / 无 stage 一律丢弃（null）', () => {
    expect(parsePluginRunProgress({ stage: 'fabricating' }, stages)).toBeNull()
    expect(parsePluginRunProgress({ stage: 42 }, stages)).toBeNull()
    expect(parsePluginRunProgress({}, stages)).toBeNull()
    expect(parsePluginRunProgress('generating', stages)).toBeNull()
    expect(parsePluginRunProgress(null, stages)).toBeNull()
    expect(parsePluginRunProgress(undefined, stages)).toBeNull()
  })

  it('extra 域字段透传（research 的 workflow 面）；stage 键不重复出现', () => {
    expect(parsePluginRunProgress({ stage: 'bucket', workflow: 'hypothesize' }, new Set(['bucket']))).toEqual({
      stage: 'bucket',
      extra: { workflow: 'hypothesize' },
    })
    expect(parsePluginRunProgress({ stage: 'bucket' }, new Set(['bucket']))!.extra).toEqual({})
  })

  it('事件名派生：kind → `<kind>_run.progress`；figure 派生与既有常量逐字一致（零变锁定）', () => {
    expect(pluginRunProgressEventName('research')).toBe('research_run.progress')
    expect(pluginRunProgressEventName('figure')).toBe(FIGURE_RUN_PROGRESS)
    expect(FIGURE_RUN_PROGRESS).toBe('figure_run.progress')
    expect(FROZEN_RUN_KIND).toBe('figure')
    // stage 枚举单源不变（autofigure manifest progressStages 声明的消费源）
    expect(FIGURE_RUN_STAGES).toEqual(['generating', 'segmenting', 'preparing', 'templating', 'assembling', 'rendering'])
  })

  it('autofigure 真插件声明承载锁定：run.kind=figure + progressStages 与核心枚举逐字一致（#853 §3.2#6 迁移零变准据）', async () => {
    const { default: autofigureManifest } = await import('../../plugins/autofigure/manifest')
    expect(autofigureManifest.run).toEqual({ kind: 'figure' })
    const tool = autofigureManifest.tools?.find((t) => t.name === 'figure_generate')
    expect(tool?.progressStages).toEqual([...FIGURE_RUN_STAGES])
  })
})

describe('createPrismaPluginRunAuditSink（TextTrace 五类审计 + runKind 盖章）', () => {
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

  function sink(runKindOf?: (toolCallId: string) => string | undefined) {
    return createPrismaPluginRunAuditSink(
      prisma,
      { ownerId, username: 'alice', sessionId: 'sess-1', runId: 'run-1' },
      ...(runKindOf !== undefined ? [{ runKindOf }] : []),
    )
  }

  async function drain(): Promise<void> {
    // fire-and-forget 落库——等一拍让 promise 链走完
    await new Promise((r) => setTimeout(r, 20))
  }

  it('created：inputText = methodText 截断，outputText 载荷含 event/toolCallId，status=success', async () => {
    sink().emitPluginRun({ event: 'created', toolCallId: 'tc1', detail: { methodText: '蛋白质折叠示意图' } })
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
    // runKindOf 未提供（figure 事件面冻结先例）→ 载荷无 runKind 列（#853 §3.2#5 零改动）
    expect('runKind' in payload).toBe(false)
    expect(row.traceId).not.toBe('')
  })

  it('stage_transitions / completed 落 success；failed / aborted 落 failed', async () => {
    const s = sink()
    s.emitPluginRun({ event: 'stage_transitions', toolCallId: 'tc1', detail: { to: 'generating' } })
    s.emitPluginRun({ event: 'completed', toolCallId: 'tc1', detail: { figureId: 'f1', iterations: 2, durationMs: 100 } })
    s.emitPluginRun({ event: 'failed', toolCallId: 'tc2', detail: { reason: 'fal API HTTP 500' } })
    s.emitPluginRun({ event: 'aborted', toolCallId: 'tc3', detail: { by: 'user' } })
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

  it('runKind 盖章：反查非空并入载荷；figure 冻结族（装配面返回 undefined）不落列', async () => {
    // 装配面语义模拟：tc-research → 'research'（落列）；tc-figure → undefined（冻结不落）
    const s = sink((toolCallId) => (toolCallId === 'tc-research' ? 'research' : undefined))
    s.emitPluginRun({ event: 'stage_transitions', toolCallId: 'tc-research', detail: { to: 'bucket' } })
    s.emitPluginRun({ event: 'created', toolCallId: 'tc-figure', detail: {} })
    await drain()
    const rows = await prisma.textTraceLog.findMany({ where: { runId: 'run-1' }, orderBy: { id: 'desc' }, take: 2 })
    const payloads = new Map(rows.map((r) => [(JSON.parse(r.outputText) as Record<string, unknown>).toolCallId as string, JSON.parse(r.outputText) as Record<string, unknown>]))
    expect(payloads.get('tc-research')!.runKind).toBe('research')
    expect('runKind' in payloads.get('tc-figure')!).toBe(false)
  })

  it('审计落库失败 fail-soft（不放大为调用方异常）', () => {
    // 外键违例（user 不存在）——fire-and-forget 面不得向调用方抛
    const broken = createPrismaPluginRunAuditSink(prisma, { ownerId: 'no-such-user', username: 'x', sessionId: 's', runId: 'r' })
    expect(() => broken.emitPluginRun({ event: 'created', toolCallId: 'tcX', detail: {} })).not.toThrow()
  })
})
