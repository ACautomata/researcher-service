// #780 片 3 D9 媒体块（S3 纯逻辑 + 服务层）：scanMediaBlocks 扫描 / TurnReducer attachment
// 事件进回放聚合（attachmentsJson media——实时 ≡ 回放零差异）/ materializeAgentMedia 物化
//（校验存在性 → 拷进 /lab/uploads/ → 建 Attachment 行）与降级路径（不存在/穿越 → null）。
// runService 的 attachment 事件发射（completed 分支）由类型面 + sessionsApi 集成回归覆盖。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PrismaClient } from '../src/generated/prisma/client'
import { createPrismaClient } from '../src/prisma'
import { AttachmentsService } from '../src/attachments/service'
import { scanMediaBlocks, lastMessage } from '../src/runner/runtime/mediaBlocks'
import { TurnReducer, serializeAttachments } from '../src/sessions/reducer'
import { seedUser } from './helpers'
import { fakePrimitives } from './runnerFakes'

describe('#780 片 3 D9 媒体块（S3）', () => {
  let prisma: PrismaClient
  let dbPath: string
  let tmpRoot: string
  let att: AttachmentsService
  let userId: string
  let sessionId: string

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), `media-test-${process.pid}-`))
    dbPath = path.join(dir, 'media.db')
    process.env.DATABASE_URL = `file:${dbPath}`
    process.env.NODE_ENV = 'test'
    prisma = createPrismaClient(`file:${dbPath}`)
    const { readFileSync } = await import('node:fs')
    const Database = (await import('better-sqlite3')).default
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    tmpRoot = mkdtempSync(path.join(tmpdir(), `media-tmp-${process.pid}-`))
    att = new AttachmentsService({ prisma, tmpRoot, archive: { readLabBytes: async () => Buffer.alloc(0) } })
    const u = await seedUser(prisma, 'media-owner', 'pw-media-secure')
    userId = u.id
    const s = await prisma.session.create({
      data: { ownerId: userId, containerId: 'researcher-sandbox-media', title: '' },
    })
    sessionId = s.id
  })
  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(tmpRoot, { recursive: true, force: true })
    rmSync(path.dirname(dbPath), { recursive: true, force: true })
  })

  // ---- scanMediaBlocks（纯逻辑）----

  it('扫描：/lab/ 白名单路径按扩展名归 mime；非 /lab（含 data URL）与白名单外扩展进降级清单', () => {
    const msg = {
      content: [
        { type: 'text', text: '图表已生成' },
        { type: 'image_url', image_url: { url: '/lab/chart.png' } },
        { type: 'image_url', image_url: { url: '/lab/clip.mp4' } },
        { type: 'image_url', image_url: { url: '/lab/doc.pdf' } }, // document V1 不放行
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, // 非路径形态
        { type: 'image_url', image_url: { url: '/lab/chart.png' } }, // 去重
        { type: 'other_block' },
      ],
    }
    const { materializable, degraded } = scanMediaBlocks(msg)
    expect(materializable).toEqual([
      { blockType: 'image_url', declaredPath: '/lab/chart.png', mime: 'image/png' },
      { blockType: 'image_url', declaredPath: '/lab/clip.mp4', mime: 'video/mp4' },
    ])
    expect(degraded).toEqual([
      { declaredPath: '/lab/doc.pdf', reason: 'mime_not_allowed' },
      { declaredPath: 'data:image/png;base64,AAAA', reason: 'not_lab' },
    ])
  })

  it('扫描：非数组 content / 空 messages → 空清单不抛（0 信任）', () => {
    expect(scanMediaBlocks({ content: '纯文本回复' })).toEqual({ materializable: [], degraded: [] })
    expect(scanMediaBlocks(null)).toEqual({ materializable: [], degraded: [] })
    expect(lastMessage([])).toBeNull()
  })

  // ---- TurnReducer：attachment 事件进回放聚合（实时 ≡ 回放）----

  it('归约：attachment 事件 → media 进 snapshot 与 attachmentsJson（回放同形状）；坏载荷静默丢弃', () => {
    const turn = new TurnReducer()
    turn.feed({ type: 'text.delta', payload: { delta: '产物如下' } })
    turn.feed({
      type: 'attachment',
      payload: { attachmentId: '123', mime: 'image/png', size: 99, fileName: 'chart.png' },
    })
    turn.feed({ type: 'attachment', payload: { attachmentId: '' } }) // 坏载荷：不进
    const snap = turn.snapshot()
    expect(snap.media).toEqual([{ attachmentId: '123', mime: 'image/png', size: 99, fileName: 'chart.png' }])
    const json = JSON.parse(serializeAttachments(snap))
    expect(json.media).toEqual([{ attachmentId: '123', mime: 'image/png', size: 99, fileName: 'chart.png' }])
    expect(turn.isEmpty()).toBe(false)
  })

  // ---- materializeAgentMedia（服务层，fakePrimitives 内存树）----

  it('物化：沙箱文件存在 → 拷进 /lab/uploads/<id>/ + 建 Attachment 行（同表同目录）', async () => {
    const fs = fakePrimitives()
    fs.trees.set('researcher-sandbox-media', new Map([['/lab/chart.png', Buffer.from('png-bytes-1')]]))
    const meta = await att.materializeAgentMedia({
      sessionId,
      ownerId: userId,
      declaredPath: '/lab/chart.png',
      mime: 'image/png',
      container: 'researcher-sandbox-media',
      primitives: fs.primitives,
    })
    expect(meta).not.toBeNull()
    expect(meta!.fileName).toBe('chart.png')
    expect(meta!.size).toBe(11)
    // 行存在（方向由挂载消息 role 派生——messageId 空，回放引用走 attachmentsJson media）
    const row = await prisma.attachment.findUnique({
      where: { sessionId_id: { sessionId, id: meta!.attachmentId } },
    })
    expect(row).toMatchObject({ ownerId: userId, mimeType: 'image/png', messageId: null })
    expect(row!.path).toBe(`/lab/uploads/${meta!.attachmentId}/chart.png`)
    // 拷贝落沙箱内存树（uploads/<id>/chart.png 字节正确）
    expect(fs.trees.get('researcher-sandbox-media')!.get(row!.path)).toEqual(Buffer.from('png-bytes-1'))
  })

  it('物化降级：声明路径不存在（已删/墓碑态）→ null（不 fail run）；穿越路径防御 → null', async () => {
    const fs = fakePrimitives()
    fs.trees.set('researcher-sandbox-media', new Map())
    const missing = await att.materializeAgentMedia({
      sessionId, ownerId: userId, declaredPath: '/lab/gone.png', mime: 'image/png',
      container: 'researcher-sandbox-media', primitives: fs.primitives,
    })
    expect(missing).toBeNull()
    const traversal = await att.materializeAgentMedia({
      sessionId, ownerId: userId, declaredPath: '/lab/../etc/passwd', mime: 'image/png',
      container: 'researcher-sandbox-media', primitives: fs.primitives,
    })
    expect(traversal).toBeNull()
  })
})
