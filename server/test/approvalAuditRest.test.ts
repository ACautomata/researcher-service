// approval_logs admin REST 测试（接缝 #2 信封级，#783 · ADR 0015 / 729 §4.3）：
// 认证/admin 门（10001/10004）· 全量审计行检索（过滤 layer/decision/userId/runId/时间窗）
// · 分页 · judge 输入只露 hash 不露全文。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'

describe('approval_logs admin REST（#783）', () => {
  let ctx: TestContext
  const base = '/api/v1/approval-logs'
  const userSeed = { username: 'aluser', password: 'pw-aluser-secure' }
  const adminSeed = { username: 'aladmin', password: 'pw-aladmin-secure' }
  let userId: string

  beforeAll(async () => {
    ctx = await setupTestApp()
    const u = await seedUser(ctx.prisma, userSeed.username, userSeed.password)
    userId = u.id
    await seedAdmin(ctx.prisma, adminSeed.username, adminSeed.password)
    // 三层审计行种子：rule allow / judge deny（含 hash 与成本列）/ human allow
    await ctx.prisma.toolApprovalLog.create({
      data: { traceId: 't1', runId: 'run-1', userId, layer: 'rule', decision: 'allow', toolName: 'write_file', toolCall: '{"file_path":"/lab/a.txt"}', reason: 'path_whitelist' },
    })
    await ctx.prisma.toolApprovalLog.create({
      data: { traceId: 't2', runId: 'run-2', userId, layer: 'judge', decision: 'deny', toolName: 'execute', toolCall: '{"command":"rm -rf /"}', policyClass: 'system_destruction', reason: '递归删除根目录', judgeInputHash: 'a'.repeat(64), latencyMs: 120, judgeTokens: 800 },
    })
    await ctx.prisma.toolApprovalLog.create({
      data: { traceId: 't3', runId: 'run-2', userId, layer: 'human', decision: 'allow', toolName: 'execute', toolCall: '{"command":"rm -rf /"}' },
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

  it('admin GET 全量 → wire 形状 + judge 只露 hash 不露输入全文', async () => {
    const l = await login(ctx.request, adminSeed.username, adminSeed.password)
    const res = await ctx.request.get(base).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data.total).toBe(3)
    const judgeRow = res.body.data.items.find((i: { layer: string }) => i.layer === 'judge')
    expect(judgeRow).toMatchObject({
      user_id: userId,
      decision: 'deny',
      policy_class: 'system_destruction',
      reason: '递归删除根目录',
      judge_input_hash: 'a'.repeat(64),
      latency_ms: 120,
      judge_tokens: 800,
    })
    expect(JSON.stringify(res.body.data)).not.toContain('judge-input-rendered') // 全文永不入行
  })

  it('过滤 layer / decision / userId / runId', async () => {
    const l = await login(ctx.request, adminSeed.username, adminSeed.password)
    const deny = await ctx.request.get(`${base}?decision=deny`).set(bearer(l.access))
    expect(deny.body.data.total).toBe(1)
    expect(deny.body.data.items[0].layer).toBe('judge')

    const human = await ctx.request.get(`${base}?layer=human`).set(bearer(l.access))
    expect(human.body.data.total).toBe(1)

    const byRun = await ctx.request.get(`${base}?runId=run-2`).set(bearer(l.access))
    expect(byRun.body.data.total).toBe(2)

    const byUser = await ctx.request.get(`${base}?userId=${userId}`).set(bearer(l.access))
    expect(byUser.body.data.total).toBe(3)

    const other = await ctx.request.get(`${base}?userId=no-such-user`).set(bearer(l.access))
    expect(other.body.data.total).toBe(0)
  })

  it('分页 page/pageSize（createdAt 降序）', async () => {
    const l = await login(ctx.request, adminSeed.username, adminSeed.password)
    const res = await ctx.request.get(`${base}?page=1&pageSize=2`).set(bearer(l.access))
    expect(res.body.data.total).toBe(3)
    expect(res.body.data.items).toHaveLength(2)
    const page2 = await ctx.request.get(`${base}?page=2&pageSize=2`).set(bearer(l.access))
    expect(page2.body.data.items).toHaveLength(1)
  })

  it('时间窗过滤（from/to 半开区间）', async () => {
    const l = await login(ctx.request, adminSeed.username, adminSeed.password)
    const future = new Date(Date.now() + 60_000).toISOString()
    const res = await ctx.request.get(`${base}?from=${encodeURIComponent(future)}`).set(bearer(l.access))
    expect(res.body.data.total).toBe(0)
    const past = new Date(Date.now() - 60_000).toISOString()
    const all = await ctx.request.get(`${base}?from=${encodeURIComponent(past)}`).set(bearer(l.access))
    expect(all.body.data.total).toBe(3)
  })
})
