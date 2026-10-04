// #780 片 2 ingestion 节点 S3（#747 Testing Decisions 纯逻辑层）：sha256 校验 → 写沙箱物化。
// 经 AttachmentsService.ingestAttachments（runner 首步调用点）断言：
//   - 校验通过 → exec mkdir + putArchive 落 /lab/uploads/<attachmentId>/（单文件 tar，字节正确）
//   - sha256 不符（临时区被改/损坏）→ 抛错（run 失败面，不进入 agent loop）
//   - 临时区字节缺失 → 抛错；附件 id 不在会话 → 抛错（无效引用）
// runner 装配（executeRun 的 ingestAttachments 调用 + 图片内联）由 sessionsApi/runnerRunService
// 集成面覆盖（S1/S4），本文件只锁纯逻辑。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PrismaClient } from '../src/generated/prisma/client'
import { createPrismaClient } from '../src/prisma'
import { AttachmentsService } from '../src/attachments/service'
import { sanitizeFileName } from '../src/attachments/values'
import { seedUser } from './helpers'
import type { SandboxFilePrimitives } from '../src/runner/backend/primitives'
import { parseTar } from '../src/files/tar'

// 记录型假原语（S2 接缝子集）：exec/putArchive 调用记录 + 内存树。
function recordingPrimitives() {
  const execCalls: { container: string; cmd: string[] }[] = []
  const putCalls: { container: string; dir: string; tar: Buffer }[] = []
  const primitives: Pick<SandboxFilePrimitives, 'exec' | 'putArchive'> = {
    exec: async (container, cmd) => {
      execCalls.push({ container, cmd })
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    putArchive: async (container, dir, tar) => {
      putCalls.push({ container, dir, tar })
    },
  }
  return { execCalls, putCalls, primitives }
}

describe('#780 片 2 ingestion（S3 纯逻辑）', () => {
  let prisma: PrismaClient
  let dbPath: string
  let tmpRoot: string
  let att: AttachmentsService
  let userId: string
  let sessionId: string

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), `ingest-test-${process.pid}-`))
    dbPath = path.join(dir, 'ingest.db')
    process.env.DATABASE_URL = `file:${dbPath}`
    process.env.NODE_ENV = 'test'
    prisma = createPrismaClient(`file:${dbPath}`)
    // 建表（init.sql 直读——setup.ts 同款，不经 prisma CLI）
    const { readFileSync } = await import('node:fs')
    const Database = (await import('better-sqlite3')).default
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    tmpRoot = mkdtempSync(path.join(tmpdir(), `ingest-tmp-${process.pid}-`))
    att = new AttachmentsService({ prisma, tmpRoot, archive: { readLabBytes: async () => Buffer.alloc(0) } })
    const u = await seedUser(prisma, 'ingest-owner', 'pw-ingest-secure')
    userId = u.id
    const s = await prisma.session.create({
      data: { ownerId: userId, containerId: 'researcher-sandbox-ingest', title: '' },
    })
    sessionId = s.id
  })
  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(tmpRoot, { recursive: true, force: true })
    rmSync(path.dirname(dbPath), { recursive: true, force: true })
  })

  // 直接写附件行 + 临时区字节（不经 REST——本文件只锁 ingestion 纯逻辑）
  async function seedAttachment(content: string, fileName = 'a.txt'): Promise<string> {
    const attachmentId = String(Date.now()) + String(Math.random()).slice(2, 6)
    writeFileSync(path.join(tmpRoot, attachmentId), content)
    const { createHash } = await import('node:crypto')
    const sha256 = createHash('sha256').update(content).digest('hex')
    const row = await prisma.attachment.create({
      data: {
        id: attachmentId,
        ownerId: userId,
        sessionId,
        fileName: sanitizeFileName(fileName),
        mimeType: 'text/plain',
        size: Buffer.byteLength(content),
        sha256,
        path: `/lab/uploads/${attachmentId}/${sanitizeFileName(fileName)}`,
      },
    })
    return row.id
  }

  it('校验通过 → exec mkdir + putArchive 单文件 tar 落 /lab/uploads/<id>/（字节正确）', async () => {
    const id = await seedAttachment('hello-ingest')
    const { execCalls, putCalls, primitives } = recordingPrimitives()
    const metas = await att.ingestAttachments({
      sessionId,
      attachmentIds: [id],
      container: 'researcher-sandbox-ingest',
      primitives,
    })
    expect(metas).toEqual([{ attachmentId: id, mimeType: 'text/plain' }])
    // mkdir -p /lab/uploads/<id> 先行
    expect(execCalls).toEqual([{ container: 'researcher-sandbox-ingest', cmd: ['mkdir', '-p', `/lab/uploads/${id}`] }])
    // putArchive 到同一 dir；tar 内含单文件 a.txt 且字节 = hello-ingest
    expect(putCalls).toHaveLength(1)
    expect(putCalls[0].dir).toBe(`/lab/uploads/${id}`)
    const entries = parseTar(putCalls[0].tar, { collectData: true })
    expect(entries.some((e) => e.name === 'a.txt' && e.data?.toString() === 'hello-ingest')).toBe(true)
  })

  it('sha256 不符（临时区被改）→ 抛错（ingestion 失败面，不物化）', async () => {
    const id = await seedAttachment('original-bytes')
    // 篡改临时区（行 sha256 不变）
    writeFileSync(path.join(tmpRoot, id), 'tampered-bytes')
    const { putCalls, primitives } = recordingPrimitives()
    const err = await att
      .ingestAttachments({ sessionId, attachmentIds: [id], container: 'c', primitives })
      .catch((e: unknown) => e)
    expect((err as Error).message).toContain('sha256')
    expect(putCalls).toHaveLength(0) // 校验失败不落任何字节
  })

  it('临时区字节缺失 → 抛错', async () => {
    const id = await seedAttachment('x')
    rmSync(path.join(tmpRoot, id)) // 删除临时区（模拟 GC/清理）
    const { primitives } = recordingPrimitives()
    const err = await att
      .ingestAttachments({ sessionId, attachmentIds: [id], container: 'c', primitives })
      .catch((e: unknown) => e)
    expect((err as Error).message).toContain('缺失')
  })

  it('附件 id 不在本会话 → 抛错（无效引用，跨会话防注入）', async () => {
    const { primitives } = recordingPrimitives()
    const err = await att
      .ingestAttachments({ sessionId, attachmentIds: ['999999999'], container: 'c', primitives })
      .catch((e: unknown) => e)
    expect((err as Error).message).toContain('无效')
  })
})
