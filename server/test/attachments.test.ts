// #780 附件域 S1（#747 Testing Decisions 信封级）：上传（REST 不直写沙箱——字节落控制面临时区
// + 元数据行）、下载（owner 门 + 不存在/越权同码 50002 防枚举，仿 figures PNG 先例）、消息发送
// 带 attachmentIds（≤4 件 + 归属/session 校验 → 挂 messageId）、100MB 上限、雪花 id 单调、
// 文件名净化（防路径穿越）。
//
// 装配：setupTestApp + createApp 注入 sessions（fake SessionRunGateway——发消息链路的 runner 面
// 用结构子集替身，dispatch 捕获命令）与 attachments（真 AttachmentsService + 假沙箱字节通道）。
// 附件字节通道（readLabBytes）返回按 relPath 预置的字节——沙箱物化是片 2 ingestion 的职责，
// 本片只验「下载端点按 path 读沙箱」的接线。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { SuperTest, Test } from 'supertest'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, login, bearer } from './helpers'
import { AttachmentsService } from '../src/attachments/service'
import { SessionService, type SessionRunGateway } from '../src/sessions/service'
import { ATTACHMENT_MAX_BYTES, sanitizeFileName } from '../src/attachments/values'
import { snowflakeId } from '../src/attachments/snowflake'
import { CODE } from '../src/codes'

// 假 SessionRunGateway（#778 门禁/命令面结构子集）：buildMessageCommand 返回最小命令，
// dispatch 捕获——发消息链路的 runner 面在附件链接测试中不需要真图执行。
function fakeRunGateway(): { gw: SessionRunGateway; dispatch: ReturnType<typeof vi.fn> } {
  const dispatch = vi.fn(async () => {})
  const gw: SessionRunGateway = {
    stateOf: () => undefined,
    abort: () => false,
    quotaFull: async () => false,
    buildMessageCommand: async (p) => ({
      runId: 'run-fake',
      sessionId: p.sessionId,
      ownerId: p.ownerId,
      username: p.username,
      kind: 'message',
      content: p.content,
      attachmentIds: p.attachmentIds,
    }),
    buildResumeCommand: (p) => ({ runId: 'run-resume', ...p, kind: 'resume' }),
  }
  return { gw, dispatch }
}

describe('#780 附件域 S1（上传/下载/消息链接）', () => {
  let ctx: TestContext
  let request: SuperTest<Test>
  let tmpRoot: string
  let archive: { readLabBytes: ReturnType<typeof vi.fn> }
  let dispatch: ReturnType<typeof vi.fn>

  beforeAll(async () => {
    ctx = await setupTestApp()
    tmpRoot = mkdtempSync(path.join(tmpdir(), `att-test-${process.pid}-`))
    // 假沙箱字节通道：relPath → 预置字节（下载端点接线；沙箱内物化属片 2 ingestion）
    archive = { readLabBytes: vi.fn(async () => Buffer.from('file-bytes')) }
    const attachments = new AttachmentsService({ prisma: ctx.prisma, tmpRoot, archive })
    const { gw, dispatch: d } = fakeRunGateway()
    dispatch = d
    const { createApp } = await import('../src/app')
    const supertestMod = (await import('supertest')).default
    const app = createApp({
      prisma: ctx.prisma,
      sessions: {
        service: new SessionService({
          prisma: ctx.prisma,
          hub: { publish: vi.fn() },
          runService: gw,
          dispatch,
          attachments,
        }),
      },
      attachments: { service: attachments, tmpRoot },
    })
    request = supertestMod(app) as unknown as SuperTest<Test>
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  async function seedUserAndSession(username: string): Promise<{ userId: string; sessionId: string }> {
    const u = await seedUser(ctx.prisma, username, 'pw-att-secure')
    const s = await ctx.prisma.session.create({
      data: { ownerId: u.id, containerId: `researcher-sandbox-${username}`, title: '' },
    })
    return { userId: u.id, sessionId: s.id }
  }

  async function uploadOne(username: string, sessionId: string, content = 'hello-attachment', fileName = 'a.txt') {
    const l = await login(request, username, 'pw-att-secure')
    const res = await request
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(bearer(l.access))
      .attach('file', Buffer.from(content), { filename: fileName, contentType: 'text/plain' })
      .field('fileName', fileName)
      .field('mimeType', 'text/plain')
    return { l, res }
  }

  it('上传：字节落控制面临时区 + 元数据行（REST 不直写沙箱）；响应含雪花 attachmentId/size/sha256/path', async () => {
    const { userId, sessionId } = await seedUserAndSession('up-owner')
    const { res } = await uploadOne('up-owner', sessionId, 'hello')
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    const meta = res.body.data
    expect(meta.attachmentId).toMatch(/^\d+$/) // 雪花 id
    expect(meta.fileName).toBe('a.txt')
    expect(meta.size).toBe(5)
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(meta.path).toBe(`/lab/uploads/${meta.attachmentId}/a.txt`)
    // 行存在 + 字节在临时区（<tmpRoot>/<attachmentId>），沙箱未动（假通道零调用）
    const row = await ctx.prisma.attachment.findUnique({
      where: { sessionId_id: { sessionId, id: meta.attachmentId } },
    })
    expect(row).toMatchObject({ ownerId: userId, mimeType: 'text/plain', messageId: null })
    expect(archive.readLabBytes).not.toHaveBeenCalled()
  })

  it('上传：文件名净化（防路径穿越——沙箱物化路径由 fileName 拼入）', async () => {
    const { sessionId } = await seedUserAndSession('up-sanitize')
    const { res } = await uploadOne('up-sanitize', sessionId, 'x', '../../etc/passwd')
    expect(res.body.code).toBe(0)
    expect(res.body.data.fileName).toBe('_.._etc_passwd') // / 与 .. 均被净化
    expect(res.body.data.path).not.toContain('/../')
  })

  it('上传：>100MB 拒绝（service 尺寸门；multer limits 为第二层）', async () => {
    const { userId, sessionId } = await seedUserAndSession('up-big')
    const att = new AttachmentsService({ prisma: ctx.prisma, tmpRoot, archive })
    // 稀疏文件模拟超大附件（truncate 报大 size、实占磁盘极少）
    const big = path.join(tmpRoot, 'big.upload')
    await writeFile(big, 'x')
    await truncate(big, ATTACHMENT_MAX_BYTES + 1)
    const err = await att
      .upload({ id: userId, role: 'user' }, sessionId, { tempPath: big, fileName: 'big.bin', mimeType: 'application/octet-stream' })
      .catch((e: unknown) => e)
    expect((err as { code?: number }).code).toBe(CODE.VALIDATION_FAILED)
  })

  it('上传：越权他人会话 → 50002（与不存在同码防探测）', async () => {
    const { sessionId } = await seedUserAndSession('up-victim')
    await seedUser(ctx.prisma, 'up-attacker', 'pw-att-secure')
    const la = await login(request, 'up-attacker', 'pw-att-secure')
    const res = await request
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(bearer(la.access))
      .attach('file', Buffer.from('x'), { filename: 'x.txt', contentType: 'text/plain' })
    expect(res.body.code).toBe(50002)
  })

  it('下载：owner 拿字节；他人/不存在同码 50002；admin 放行', async () => {
    const { sessionId } = await seedUserAndSession('dl-owner')
    const { res } = await uploadOne('dl-owner', sessionId, 'download-me')
    expect(res.body.code).toBe(0)
    const id = res.body.data.attachmentId
    // 预置沙箱字节（readLabBytes 按 relPath 返回）
    archive.readLabBytes.mockResolvedValue(Buffer.from('download-me'))

    // owner → 200 原生字节 + Content-Type
    const lo = await login(request, 'dl-owner', 'pw-att-secure')
    const own = await request.get(`/api/v1/attachments/${id}/download`).set(bearer(lo.access))
    expect(own.status).toBe(200)
    expect(own.text).toBe('download-me')
    expect(own.headers['content-type']).toContain('text/plain')
    // 沙箱容器名 = researcher-sandbox-<sessionId>（真实 session id，非 username 派生值）
    expect(archive.readLabBytes).toHaveBeenCalledWith(`researcher-sandbox-${sessionId}`, `uploads/${id}/a.txt`)

    // 他人 → 50002；不存在 id → 50002（逐字节同码）
    await seedUser(ctx.prisma, 'dl-attacker', 'pw-att-secure')
    const lx = await login(request, 'dl-attacker', 'pw-att-secure')
    const cross = await request.get(`/api/v1/attachments/${id}/download`).set(bearer(lx.access))
    const missing = await request.get(`/api/v1/attachments/999999/download`).set(bearer(lx.access))
    expect(cross.body.code).toBe(50002)
    expect(cross.body).toEqual(missing.body)

    // admin → 放行
    const { seedAdmin } = await import('./helpers')
    await seedAdmin(ctx.prisma, 'dl-admin', 'pw-att-secure')
    const la = await login(request, 'dl-admin', 'pw-att-secure')
    const admin = await request.get(`/api/v1/attachments/${id}/download`).set(bearer(la.access))
    expect(admin.status).toBe(200)
  })

  it('消息发送带 attachmentIds → 附件行挂 messageId；≤4 件超限 90002；跨会话/他人附件 50002', async () => {
    const { sessionId } = await seedUserAndSession('msg-owner')
    const l = await login(request, 'msg-owner', 'pw-att-secure')
    // 上传 2 件
    const up1 = await uploadOne('msg-owner', sessionId, 'one')
    const up2 = await uploadOne('msg-owner', sessionId, 'two', 'b.txt')
    const id1 = up1.res.body.data.attachmentId
    const id2 = up2.res.body.data.attachmentId
    const id3 = up2.res.body.data.attachmentId // 复用同 id 造重（不超 4）

    // 正常发送带 2 件 → 链接
    const send = await request
      .post(`/api/v1/sessions/${sessionId}/messages`)
      .set(bearer(l.access))
      .set('Idempotency-Key', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')
      .send({ content: '看图', attachmentIds: [id1, id2] })
    expect(send.body.code).toBe(0)
    const row = await ctx.prisma.attachment.findMany({ where: { sessionId, id: { in: [id1, id2] } } })
    expect(row.every((r) => r.messageId === send.body.data.messageId)).toBe(true)
    // dispatch 携带 attachmentIds（片 2 ingestion 消费）
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ attachmentIds: [id1, id2] }))

    // 5 件（schema max 4）→ 90002
    const over = await request
      .post(`/api/v1/sessions/${sessionId}/messages`)
      .set(bearer(l.access))
      .set('Idempotency-Key', 'b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')
      .send({ content: '超限', attachmentIds: [id1, id2, id3, id1, id2] })
    expect(over.body.code).toBe(90002)

    // 跨会话附件 → 50002（他人会话上传的 id 不在本会话）
    const other = await seedUserAndSession('msg-other')
    const { res: upOther } = await uploadOne('msg-other', other.sessionId, 'other')
    const cross = await request
      .post(`/api/v1/sessions/${sessionId}/messages`)
      .set(bearer(l.access))
      .set('Idempotency-Key', 'c1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')
      .send({ content: '跨会话', attachmentIds: [upOther.body.data.attachmentId] })
    expect(cross.body.code).toBe(50002)
  })

  it('纯逻辑：雪花 id 单调递增且唯一；sanitizeFileName 净化穿越与空值', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => snowflakeId(1_700_000_000_000 + i))
    expect(new Set(ids).size).toBe(ids.length)
    for (let i = 1; i < ids.length; i++) expect(BigInt(ids[i]) > BigInt(ids[i - 1])).toBe(true)
    expect(sanitizeFileName('a/b\\c\u0000d')).toBe('a_b_c_d')
    expect(sanitizeFileName('../etc/passwd')).toBe('_etc_passwd') // 前导 .. 被剥、/ 替换
    expect(sanitizeFileName('..')).toBe('file') // 纯穿越 → 空 → 回退 file
    expect(sanitizeFileName('')).toBe('file')
    expect(sanitizeFileName('///')).toBe('___')
  })
})
