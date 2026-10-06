// figures.create 句柄幂等（#792 · #744 §5.3 · S3）：去重身份 = 调用方 run 的 toolCallId
//（filejournal ALS 盖印的真实 tool_call_id）——同 toolCallId 不重复建 Figure 行；
// ALS 缺失降级直写；失败可重试；上限滚动清理。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createFiguresToolPort } from '../src/figures/toolPort'
import { runWithToolCallContext } from '../src/runner/filejournal/context'
import { createPrismaClient } from '../src/prisma'
import { seedUser } from './helpers'
import type { PrismaClient } from '../src/generated/prisma/client'

describe('createFiguresToolPort（幂等去重）', () => {
  let prisma: PrismaClient
  let dir: string
  let ownerId: string
  const dedupe = new Map<string, Promise<{ figureId: string }>>()

  function create(input: Partial<Parameters<ReturnType<typeof createFiguresToolPort>['create']>[0]> = {}) {
    return {
      prompt: '方法示意',
      svg: '<svg/>',
      meta: { v: 1 },
      sessionId: 'sess-1',
      ...input,
    }
  }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'figure-port-'))
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma, 'figure-port-user', 'pw-figure-port-secure')
    ownerId = user.id
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  function port() {
    return createFiguresToolPort({ prisma, dedupe }, ownerId)
  }

  it('同 toolCallId 二次 create = 同一 figureId，仅一行（重入不重复生成）', async () => {
    const first = await runWithToolCallContext({ toolCallId: 'tc-same', threadId: 'sess-1' }, () => port().create(create()))
    const second = await runWithToolCallContext({ toolCallId: 'tc-same', threadId: 'sess-1' }, () => port().create(create()))
    expect(second.figureId).toBe(first.figureId)
    expect(await prisma.figure.count({ where: { prompt: '方法示意' } })).toBe(1)
  })

  it('不同 toolCallId 各建一行', async () => {
    const before = await prisma.figure.count()
    const a = await runWithToolCallContext({ toolCallId: 'tc-a', threadId: 'sess-1' }, () => port().create(create()))
    const b = await runWithToolCallContext({ toolCallId: 'tc-b', threadId: 'sess-1' }, () => port().create(create()))
    expect(a.figureId).not.toBe(b.figureId)
    expect(await prisma.figure.count()).toBe(before + 2)
  })

  it('ALS 缺失（非工具路径）降级直写', async () => {
    const before = await prisma.figure.count()
    const r = await port().create(create({ prompt: '降级直写' }))
    expect(r.figureId).not.toBe('')
    expect(await prisma.figure.count()).toBe(before + 1)
  })

  it('create 输入完整落库（prompt/svg/meta/sessionId/pngBytes）', async () => {
    await runWithToolCallContext({ toolCallId: 'tc-full', threadId: 'sess-1' }, () =>
      port().create(create({ prompt: '完整落库', pngBytes: new Uint8Array([1, 2, 3]) })))
    const row = await prisma.figure.findFirstOrThrow({ where: { prompt: '完整落库' } })
    expect(row.svg).toBe('<svg/>')
    expect(row.evaluation).toBe(JSON.stringify({ v: 1 }))
    expect(Buffer.from(row.png!).length).toBe(3)
    expect(row.ownerId).toBe(ownerId)
  })

  it('失败从去重表移除（允许重试），成功后永留（并发同 id 单建行）', async () => {
    // 并发双 create 同 toolCallId：共享同一 promise，只落一行
    const [x, y] = await Promise.all([
      runWithToolCallContext({ toolCallId: 'tc-cc', threadId: 'sess-1' }, () => port().create(create({ prompt: '并发' }))),
      runWithToolCallContext({ toolCallId: 'tc-cc', threadId: 'sess-1' }, () => port().create(create({ prompt: '并发' }))),
    ])
    expect(x.figureId).toBe(y.figureId)
    expect(await prisma.figure.count({ where: { prompt: '并发' } })).toBe(1)
  })

  it('上限滚动清理（超限清空——只丢去重不丢正确性）', async () => {
    const tiny = new Map<string, Promise<{ figureId: string }>>()
    const p = createFiguresToolPort({ prisma, dedupe: tiny, dedupeMax: 2 }, ownerId)
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const r = await runWithToolCallContext({ toolCallId: `tc-cap-${i}`, threadId: 'sess-1' }, () => p.create(create({ prompt: `cap-${i}` })))
      ids.push(r.figureId)
    }
    expect(tiny.size).toBeLessThanOrEqual(2)
    expect(new Set(ids).size).toBe(5)
  })
})
