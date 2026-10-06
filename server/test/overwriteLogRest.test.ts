// file_overwrite_logs admin REST 测试（接缝 #2 信封级，#785 · #747 E 节锁方案「合法覆盖
// 审计计数进审计域」）：认证/admin 门（10001/10004）· 覆盖审计行检索（过滤 sessionId/path/
// 时间窗）· 分页。approval_logs admin REST 同款形状。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'

describe('file_overwrite_logs admin REST（#785）', () => {
  let ctx: TestContext
  const base = '/api/v1/file-overwrite-logs'
  const userSeed = { username: 'woluser', password: 'pw-woluser-secure' }
  const adminSeed = { username: 'woladmin', password: 'pw-woladmin-secure' }

  beforeAll(async () => {
    ctx = await setupTestApp()
    await seedUser(ctx.prisma, userSeed.username, userSeed.password)
    await seedAdmin(ctx.prisma, adminSeed.username, adminSeed.password)
    // 覆盖审计行种子：同会话两 path + 另一会话一 path（时间窗/过滤面）。表为弱关联无 FK
    // （审计快照纪律）——sessionId/threadId 存字符串快照，无需种子会话行。
    await ctx.prisma.fileOverwriteLog.create({
      data: { sessionId: 'sess-ow-1', path: 'lab/report.md', overwriterThreadId: 'sess-ow-1', overwrittenThreadId: 't-teammate-a', runId: 'run-1' },
    })
    await ctx.prisma.fileOverwriteLog.create({
      data: { sessionId: 'sess-ow-1', path: 'wiki/index.md', overwriterThreadId: 'sess-ow-1', overwrittenThreadId: 't-teammate-b', runId: 'run-2' },
    })
    await ctx.prisma.fileOverwriteLog.create({
      data: { sessionId: 'sess-ow-2', path: 'lab/report.md', overwriterThreadId: 'sess-ow-2', overwrittenThreadId: 't-teammate-a', runId: 'run-3' },
    })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('未认证 → 10001', async () => {
    const res = await ctx.request.get(base)
    expect(res.body.code).toBe(10001)
  })

  it('非 admin → 10004', async () => {
    const l = await login(ctx.request, userSeed.username, userSeed.password)
    const res = await ctx.request.get(base).set(bearer(l.access))
    expect(res.body.code).toBe(10004)
  })

  it('admin GET 全量 → wire 形状（path/覆盖者/被覆盖者/run）', async () => {
    const l = await login(ctx.request, adminSeed.username, adminSeed.password)
    const res = await ctx.request.get(base).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data.total).toBe(3)
    const row = res.body.data.items.find((i: { path: string; session_id: string }) => i.path === 'lab/report.md' && i.session_id === 'sess-ow-1')
    expect(row).toMatchObject({
      session_id: 'sess-ow-1',
      path: 'lab/report.md',
      overwriter_thread_id: 'sess-ow-1',
      overwritten_thread_id: 't-teammate-a',
      run_id: 'run-1',
    })
    expect(row.created_at).toBeTruthy()
  })

  it('过滤 sessionId + path；分页 page/pageSize', async () => {
    const l = await login(ctx.request, adminSeed.username, adminSeed.password)
    const filtered = await ctx.request
      .get(`${base}?sessionId=sess-ow-1&path=lab/report.md`)
      .set(bearer(l.access))
    expect(filtered.body.data.total).toBe(1)
    expect(filtered.body.data.items[0]).toMatchObject({ overwritten_thread_id: 't-teammate-a' })

    const paged = await ctx.request.get(`${base}?page=2&pageSize=2`).set(bearer(l.access))
    expect(paged.body.data.total).toBe(3)
    expect(paged.body.data.page).toBe(2)
    expect(paged.body.data.items).toHaveLength(1)
  })
})
