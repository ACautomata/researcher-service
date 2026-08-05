// containers pairing approve REST 测试（#371-1 / #374 · ADR 0006 B2 后端 approve 编排）。
// 浏览器首连遇 PAIRING_REQUIRED{requestId} → 前端自动 POST …/pairing/approve/{requestId}；
// 后端经注入假 runtime（docker exec fake）在容器内执行 `openclaw devices approve <requestId>`。
// 覆盖：归属门（user 仅自己 / admin 全放行）/ 越权与不存在同码 20040 字节级一致 / exec 调用含正确
// 参数 / Pairing 行 pending→paired + pairingRequestId 记账 + deviceId/scopes 保留 / 非 running →
// 20046 / 非法 requestId → 90002 / 响应体无 token 明文 / 重复 approve 幂等不重复 exec /
// exec 失败不标 paired / 未认证 10001。全部经假 runtime，不依赖真 docker daemon。

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import { makeFleetTest } from './fleetTestUtils'
import type { FakeRuntime } from './fakeRuntime'

// exec 调用形（approve CLI argv，对齐 backend/chat/pairing.py _OPENCLAW_APPROVE_CMD）
const APPROVE_CMD = ['openclaw', 'devices', 'approve']

describe('containers pairing approve（#371-1 / #374）', () => {
  let ctx: TestContext
  let runtime: FakeRuntime

  beforeAll(async () => {
    ctx = await setupTestApp()
    const fl = makeFleetTest(ctx.prisma)
    runtime = fl.runtime
    // containers 路由在 orchestrator + runtime 注入时才挂载（app.ts）；本测试断言 approve 编排，
    // 用假 runtime 记录 exec 调用（接缝 #5），不触真 docker daemon。
    const { createApp } = await import('../src/app')
    const supertest = (await import('supertest')).default
    const app = createApp({ prisma: ctx.prisma, orchestrator: fl.orch, runtime: fl.runtime })
    ctx.request = supertest(app) as unknown as TestContext['request']
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  // execCalls 全文件共享的 FakeRuntime 累积记录 → 每测试重置，断言 exec 次数才不跨用例污染。
  beforeEach(() => {
    runtime.execCalls = []
  })

  // 确定性端口分配（DB port @unique，同文件内递增避免冲突）
  let nextPort = 19000

  async function seedContainer(name: string, ownerId: string, status = 'running'): Promise<string> {
    const row = await ctx.prisma.container.create({
      data: {
        name,
        port: nextPort++,
        ownerId,
        token: 'sealed',
        homeDir: `/h/${name}`,
        image: 'img',
        status: status as 'running' | 'stopped',
      },
    })
    return row.id
  }

  const approve = (access: string | undefined, name: string, requestId: string) =>
    ctx.request
      .post(`/api/v1/containers/${name}/pairing/approve/${encodeURIComponent(requestId)}`)
      .set(bearer(access))

  // 本文件不触编排器 create/delete → runtime.execCalls 仅含 approve 的 exec
  const approveExecCalls = () => runtime.execCalls.filter((c) => c.cmd[0] === 'openclaw')

  it('属主 approve 合法 requestId → exec 调用正确 + Pairing paired + 响应无 token', async () => {
    const u = await seedUser(ctx.prisma, 'u-pa1', 'pw-pa1-secure')
    const cid = await seedContainer('pair-c1', u.id)
    const l = await login(ctx.request, 'u-pa1', 'pw-pa1-secure')
    const r = await approve(l.access, 'pair-c1', 'req_abc.123~xyz')
    expect(r.status).toBe(200)
    expect(r.body.code).toBe(0)
    // 响应体仅 status，无任何 token/密钥字段（#371 User Story 8）
    expect(r.body.data).toEqual({ status: 'paired' })
    expect(JSON.stringify(r.body)).not.toMatch(/device_token|private_key_pem/)
    expect(approveExecCalls()).toEqual([
      { name: 'pair-c1', cmd: [...APPROVE_CMD, 'req_abc.123~xyz'] },
    ])
    const row = await ctx.prisma.pairing.findUnique({ where: { containerId: cid } })
    expect(row?.status).toBe('paired')
    expect(row?.pairingRequestId).toBe('req_abc.123~xyz')
  })

  it('pending 行 approve → paired，deviceId/scopes 保留（记账不丢）', async () => {
    const u = await seedUser(ctx.prisma, 'u-pa2', 'pw-pa2-secure')
    const cid = await seedContainer('pair-c2', u.id)
    await ctx.prisma.pairing.create({
      data: {
        containerId: cid,
        status: 'pending',
        deviceId: 'dev-1',
        scopesJson: JSON.stringify(['operator.read', 'operator.write']),
      },
    })
    const l = await login(ctx.request, 'u-pa2', 'pw-pa2-secure')
    const r = await approve(l.access, 'pair-c2', 'req-pending')
    expect(r.body.code).toBe(0)
    const row = await ctx.prisma.pairing.findUnique({ where: { containerId: cid } })
    expect(row?.status).toBe('paired') // pending→paired
    expect(row?.pairingRequestId).toBe('req-pending')
    expect(row?.deviceId).toBe('dev-1') // 记账保留，不因 approve 清空
    expect(row?.scopesJson).toBe(JSON.stringify(['operator.read', 'operator.write']))
  })

  it('admin 跨用户容器 → 放行', async () => {
    const u = await seedUser(ctx.prisma, 'u-pa3', 'pw-pa3-secure')
    await seedContainer('pair-c3', u.id)
    await seedAdmin(ctx.prisma, 'adm-pa', 'pw-admpa-secure')
    const l = await login(ctx.request, 'adm-pa', 'pw-admpa-secure')
    const r = await approve(l.access, 'pair-c3', 'req-admin')
    expect(r.body.code).toBe(0)
    expect(r.body.data.status).toBe('paired')
  })

  it('user 对他人容器与不存在 → 同码 20040 且响应字节级一致（防探测，不触发 exec）', async () => {
    await seedUser(ctx.prisma, 'u-pa4', 'pw-pa4-secure')
    const b = await seedUser(ctx.prisma, 'u-pa5', 'pw-pa5-secure')
    await seedContainer('other-c', b.id)
    const la = await login(ctx.request, 'u-pa4', 'pw-pa4-secure')
    const cross = await approve(la.access, 'other-c', 'req-x')
    const missing = await approve(la.access, 'ghost-c', 'req-x')
    expect(cross.body.code).toBe(20040)
    expect(missing.body.code).toBe(20040)
    expect(cross.body).toEqual(missing.body) // 「不存在 vs 越权」不分裂
    expect(approveExecCalls()).toHaveLength(0)
  })

  it('非法容器 name → 90002 + data.name（区别于 20040）', async () => {
    await seedUser(ctx.prisma, 'u-pa6', 'pw-pa6-secure')
    const l = await login(ctx.request, 'u-pa6', 'pw-pa6-secure')
    const r = await approve(l.access, 'INVALID_NAME', 'req-x')
    expect(r.body.code).toBe(90002)
    expect(r.body.data.name).toBeTruthy()
    expect(approveExecCalls()).toHaveLength(0)
  })

  it('非 running 容器 → 20046（creating/stopped/removing 同码，不触发 exec）', async () => {
    const u = await seedUser(ctx.prisma, 'u-pa7', 'pw-pa7-secure')
    await seedContainer('stopped-c', u.id, 'stopped')
    const l = await login(ctx.request, 'u-pa7', 'pw-pa7-secure')
    const r = await approve(l.access, 'stopped-c', 'req-x')
    expect(r.body.code).toBe(20046)
    expect(approveExecCalls()).toHaveLength(0)
  })

  it('非法 requestId → 90002 + data.requestId（不触发 exec）', async () => {
    const u = await seedUser(ctx.prisma, 'u-pa8', 'pw-pa8-secure')
    await seedContainer('pair-c8', u.id)
    const l = await login(ctx.request, 'u-pa8', 'pw-pa8-secure')
    const r = await approve(l.access, 'pair-c8', 'bad request id!')
    expect(r.body.code).toBe(90002)
    expect(r.body.data.requestId).toBeTruthy()
    expect(approveExecCalls()).toHaveLength(0)
  })

  it('重复 approve 同一 requestId → 幂等 ok，不重复 exec、不报错', async () => {
    const u = await seedUser(ctx.prisma, 'u-pa9', 'pw-pa9-secure')
    await seedContainer('pair-c9', u.id)
    const l = await login(ctx.request, 'u-pa9', 'pw-pa9-secure')
    const first = await approve(l.access, 'pair-c9', 'req-idem')
    expect(first.body.code).toBe(0)
    expect(approveExecCalls()).toHaveLength(1)
    const second = await approve(l.access, 'pair-c9', 'req-idem')
    expect(second.body.code).toBe(0)
    expect(second.body.data.status).toBe('paired')
    expect(approveExecCalls()).toHaveLength(1) // 未重复 exec
  })

  it('stopped 但已 paired 的容器重复 approve 同一 requestId → 幂等 ok（非 20046，不 exec）', async () => {
    const u = await seedUser(ctx.prisma, 'u-pa11', 'pw-pa11-secure')
    const cid = await seedContainer('stopped-paired', u.id, 'stopped')
    await ctx.prisma.pairing.create({
      data: { containerId: cid, status: 'paired', pairingRequestId: 'req-stopped' },
    })
    const l = await login(ctx.request, 'u-pa11', 'pw-pa11-secure')
    const r = await approve(l.access, 'stopped-paired', 'req-stopped')
    expect(r.body.code).toBe(0) // 该 approve 早已完成 → 幂等 ok，而非 20046
    expect(r.body.data.status).toBe('paired')
    expect(approveExecCalls()).toHaveLength(0)
  })

  it('容器内 exec 失败 → 报错且 Pairing 不标 paired', async () => {
    const u = await seedUser(ctx.prisma, 'u-pa10', 'pw-pa10-secure')
    const cid = await seedContainer('pair-cfail', u.id)
    await ctx.prisma.pairing.create({
      data: { containerId: cid, status: 'pending', pairingRequestId: 'req-old' },
    })
    runtime.failExecSyncFor.add('pair-cfail')
    const l = await login(ctx.request, 'u-pa10', 'pw-pa10-secure')
    const r = await approve(l.access, 'pair-cfail', 'req-fail')
    expect(r.body.code).not.toBe(0)
    const row = await ctx.prisma.pairing.findUnique({ where: { containerId: cid } })
    expect(row?.status).toBe('pending') // 失败不推进状态
    expect(row?.pairingRequestId).toBe('req-old')
    runtime.failExecSyncFor.delete('pair-cfail')
  })

  it('未认证 → 10001', async () => {
    const r = await ctx.request.post('/api/v1/containers/x/pairing/approve/req')
    expect(r.body.code).toBe(10001)
  })
})
