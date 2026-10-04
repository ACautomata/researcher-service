// #780 附件性能门基准（spec D6/C7 ·「基准入 S4，不达标砍 100MB 上限」）：
// 小 op（ingestion 物化）捕获 p95 ≤ 50ms——假原语（S2 接缝）计时，无 docker/网络噪声。
// 100 小 op 重放 ≤5s 与 100MB op 进度面属 file rewind 机制（#781 file_journal 票）的性能门，
// 不在本票（附件域只锁「上传→临时区→ingestion」链路的捕获时延）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PrismaClient } from '../src/generated/prisma/client'
import { createPrismaClient } from '../src/prisma'
import { AttachmentsService } from '../src/attachments/service'
import { seedUser } from './helpers'
import { fakePrimitives } from './runnerFakes'

describe('#780 附件性能门（S4 基准）', () => {
  let prisma: PrismaClient
  let dbPath: string
  let tmpRoot: string
  let att: AttachmentsService
  let userId: string
  let sessionId: string

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), `att-perf-${process.pid}-`))
    dbPath = path.join(dir, 'perf.db')
    process.env.DATABASE_URL = `file:${dbPath}`
    process.env.NODE_ENV = 'test'
    prisma = createPrismaClient(`file:${dbPath}`)
    const { readFileSync } = await import('node:fs')
    const Database = (await import('better-sqlite3')).default
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    tmpRoot = mkdtempSync(path.join(tmpdir(), `att-perf-tmp-${process.pid}-`))
    att = new AttachmentsService({ prisma, tmpRoot, archive: { readLabBytes: async () => Buffer.alloc(0) } })
    const u = await seedUser(prisma, 'perf-owner', 'pw-perf-secure')
    userId = u.id
    const s = await prisma.session.create({
      data: { ownerId: userId, containerId: 'researcher-sandbox-perf', title: '' },
    })
    sessionId = s.id
  })
  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(tmpRoot, { recursive: true, force: true })
    rmSync(path.dirname(dbPath), { recursive: true, force: true })
  })

  it('小 op（ingestion 物化）捕获 p95 ≤ 50ms（50 次采样，8KB 文件，假原语）', async () => {
    const { primitives } = fakePrimitives()
    const durations: number[] = []
    for (let i = 0; i < 50; i++) {
      const id = `perf-${i}-${Date.now()}`
      const content = Buffer.alloc(8 * 1024, 'x')
      writeFileSync(path.join(tmpRoot, id), content)
      const { createHash } = await import('node:crypto')
      await prisma.attachment.create({
        data: {
          id,
          ownerId: userId,
          sessionId,
          fileName: `f${i}.bin`,
          mimeType: 'application/octet-stream',
          size: content.length,
          sha256: createHash('sha256').update(content).digest('hex'),
          path: `/lab/uploads/${id}/f${i}.bin`,
        },
      })
      const t0 = performance.now()
      const metas = await att.ingestAttachments({
        sessionId,
        attachmentIds: [id],
        container: 'researcher-sandbox-perf',
        primitives,
      })
      durations.push(performance.now() - t0)
      expect(metas).toHaveLength(1)
    }
    durations.sort((a, b) => a - b)
    const p95 = durations[Math.floor(durations.length * 0.95) - 1] ?? durations[durations.length - 1]!
    expect(p95).toBeLessThanOrEqual(50)
  })
})
