import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import supertest, { type SuperTest, type Test } from 'supertest'
import type { Application } from 'express'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import { Orchestrator } from '../src/orchestrator/orchestrator'
import { FakeRuntime, MemoryQueue, testTokenCrypto } from './fakes'
import { createApp } from '../src/app'

// 接缝 2 信封 REST：注入假身份（admin/user）打 /api/v1/containers/。
// 断言 HTTP 200 + 信封码 + 归属前置（#312：user 仅本人 / admin 全量 / 越权 20040 同码）。

let ctx: TestContext
let dir: string
let runtime: FakeRuntime
let queue: MemoryQueue
let orchestrator: Orchestrator
let app: Application
let request: SuperTest<Test>

beforeAll(async () => {
  ctx = await setupTestApp()
  await seedAdmin(ctx.prisma)
  await seedUser(ctx.prisma, 'user1', 'pw-user1-secure')
  dir = mkdtempSync(path.join(tmpdir(), `crt-${process.pid}-`))
  mkdirSync(path.join(dir, 'template', 'workspace'), { recursive: true })
  writeFileSync(path.join(dir, 'template', 'workspace', 'note.md'), 'hi')
  writeFileSync(path.join(dir, 'tpl.json'), '{}')
})

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  await ctx.cleanup()
})

// 每测试独立状态：清容器行（释放配额/端口）+ 重建 fake runtime/queue + 重建 orchestrator + app。
// 路由与 provision() 共用同一 orchestrator 实例——createReserve 持有租约直到 provisioning 完成，
// provisionCreate（模拟 worker）会释放它；若分开实例租约永不释放 → deleteEnqueue 误判在飞。
beforeEach(async () => {
  await ctx.prisma.container.deleteMany({})
  runtime = new FakeRuntime()
  queue = new MemoryQueue()
  rmSync(path.join(dir, 'instances'), { recursive: true, force: true })
  orchestrator = makeOrch()
  app = createApp({ prisma: ctx.prisma, orchestrator })
  request = supertest(app) as unknown as SuperTest<Test>
})

function makeOrch(): Orchestrator {
  return new Orchestrator(ctx.prisma, runtime, queue, {
    fleetRoot: dir,
    templateDir: path.join(dir, 'template'),
    templateJsonPath: path.join(dir, 'tpl.json'),
    image: 'img:tag',
    llmApiKey: 'sk-test',
    portPoolStart: 19000,
    portPoolEnd: 19999,
    gatewayTokenBytes: 32,
    tokenCrypto: testTokenCrypto(),
    portInUse: async () => false,
  })
}

async function provision(name: string): Promise<void> {
  // 同步模拟 worker 消费：provisionCreate 后行 running（同一 orchestrator，释放路由的租约）
  const job = queue.lastCreate(name)
  await orchestrator.provisionCreate(job.name, job.configText)
}

describe('containers 隔离（#312）', () => {
  it('user GET / → 仅自己容器；admin GET / → 全部', async () => {
    // 用户建 1 个 + 管理建 1 个
    const u = await login(request, 'user1', 'pw-user1-secure')
    const a = await login(request, 'admin1', 'pw-admin1-secure')
    const r1 = await request.post('/api/v1/containers').set(bearer(u.access)).send({ name: 'u-c1' })
    expect(r1.body.code).toBe(0)
    expect(r1.body.data.status).toBe('creating')
    await provision('u-c1')
    const r2 = await request.post('/api/v1/containers').set(bearer(a.access)).send({ name: 'a-c1' })
    expect(r2.body.code).toBe(0)
    await provision('a-c1')

    const uList = await request.get('/api/v1/containers').set(bearer(u.access))
    expect(uList.body.code).toBe(0)
    const uNames = (uList.body.data as Record<string, unknown>[]).map((c) => c.name)
    expect(uNames).toContain('u-c1')
    expect(uNames).not.toContain('a-c1') // 隔离：看不到 admin 的

    const aList = await request.get('/api/v1/containers').set(bearer(a.access))
    expect(aList.body.code).toBe(0)
    const aNames = (aList.body.data as Record<string, unknown>[]).map((c) => c.name)
    expect(aNames).toContain('u-c1')
    expect(aNames).toContain('a-c1') // admin 见全部
  })

  it('codex 六轮 P1：admin 删跨用户容器放行（不被 ownerId 挡）', async () => {
    const u = await login(request, 'user1', 'pw-user1-secure')
    const a = await login(request, 'admin1', 'pw-admin1-secure')
    await request.post('/api/v1/containers').set(bearer(u.access)).send({ name: 'u-xdel' })
    await provision('u-xdel')
    // admin 删 user1 的容器 → 放行（codex 五轮 #4 加了 ownerId 严格校验但 admin 须豁免）
    const del = await request.delete('/api/v1/containers/u-xdel').set(bearer(a.access))
    expect(del.body.code).toBe(0)
    // worker 消费 delete job → 消失
    await orchestrator.provisionDelete(queue.lastDelete('u-xdel').name, queue.lastDelete('u-xdel').rowId)
    expect(await ctx.prisma.container.findUnique({ where: { name: 'u-xdel' } })).toBeNull()
  })

  it('codex 三轮 P1：GET / health 经 runtime 对账（容器不在 → stopped 非 healthy）', async () => {
    const u = await login(request, 'user1', 'pw-user1-secure')
    await request.post('/api/v1/containers').set(bearer(u.access)).send({ name: 'u-health' })
    await provision('u-health')
    // 容器在 fake runtime 里 running → healthy
    let list = await request.get('/api/v1/containers').set(bearer(u.access))
    let item = (list.body.data as Record<string, unknown>[]).find((c) => c.name === 'u-health')!
    expect(item.health).toBe('healthy')
    // 模拟容器被外部删除（fake runtime 里移除）→ health 应变 stopped（DB 仍 running）
    runtime.containers.delete('u-health')
    list = await request.get('/api/v1/containers').set(bearer(u.access))
    item = (list.body.data as Record<string, unknown>[]).find((c) => c.name === 'u-health')!
    expect(item.status).toBe('running') // DB 编排态不变
    expect(item.health).toBe('stopped') // runtime 对账：容器不在
  })

  it('越权访问他人容器 → 20040 且与「不存在」逐字节同码', async () => {
    const u = await login(request, 'user1', 'pw-user1-secure')
    // admin 建的 a-c1 不属于 user1 → user1 删 → 20040
    const forbidden = await request.delete('/api/v1/containers/a-c1').set(bearer(u.access))
    expect(forbidden.body.code).toBe(20040)
    // 不存在的容器 → 同码
    const missing = await request.delete('/api/v1/containers/nonexistent').set(bearer(u.access))
    expect(missing.body.code).toBe(20040)
    expect(forbidden.body).toEqual(missing.body) // 逐字节一致（防探测）
  })

  it('POST 同名 → 20041（不分占用者）', async () => {
    const u = await login(request, 'user1', 'pw-user1-secure')
    const a = await login(request, 'admin1', 'pw-admin1-secure')
    // 先建一个（干净测试态）
    await request.post('/api/v1/containers').set(bearer(u.access)).send({ name: 'u-c1' })
    // user1 再建同名 → 撞名
    const res = await request.post('/api/v1/containers').set(bearer(u.access)).send({ name: 'u-c1' })
    expect(res.body.code).toBe(20041)
    // admin 建同名 → 也 20041（name 全局唯一，不分占用者）
    const res2 = await request.post('/api/v1/containers').set(bearer(a.access)).send({ name: 'u-c1' })
    expect(res2.body.code).toBe(20041)
  })

  it('POST 超配额 → 20042', async () => {
    // user1 maxContainers=3：建满 3 个 → 第 4 个超限
    const u = await login(request, 'user1', 'pw-user1-secure')
    await request.post('/api/v1/containers').set(bearer(u.access)).send({ name: 'u-c1' })
    await request.post('/api/v1/containers').set(bearer(u.access)).send({ name: 'u-c2' })
    await request.post('/api/v1/containers').set(bearer(u.access)).send({ name: 'u-c3' })
    const res = await request.post('/api/v1/containers').set(bearer(u.access)).send({ name: 'u-c4' })
    expect(res.body.code).toBe(20042)
  })

  it('POST name 非法 → 90002(data.name)', async () => {
    const u = await login(request, 'user1', 'pw-user1-secure')
    const res = await request.post('/api/v1/containers').set(bearer(u.access)).send({ name: 'Bad Name!' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('name')
  })

  it('DELETE 异步 → 立即返信封；list 轮询见 removing→消失', async () => {
    const u = await login(request, 'user1', 'pw-user1-secure')
    await request.post('/api/v1/containers').set(bearer(u.access)).send({ name: 'u-del' })
    await provision('u-del')
    const del = await request.delete('/api/v1/containers/u-del').set(bearer(u.access))
    expect(del.body.code).toBe(0) // 立即返信封（已入队）
    expect(del.body.data).toBeNull()
    // 行仍在（worker 未跑）→ 轮询 observing removing
    const before = await request.get('/api/v1/containers').set(bearer(u.access))
    expect((before.body.data as Record<string, unknown>[]).find((c) => c.name === 'u-del')?.status).toBe('running')
    // worker 消费 delete job → 消失
    await orchestrator.provisionDelete(queue.lastDelete('u-del').name)
    const after = await request.get('/api/v1/containers').set(bearer(u.access))
    expect((after.body.data as Record<string, unknown>[]).find((c) => c.name === 'u-del')).toBeUndefined()
  })

  it('codex #6：入队 delete 失败（Redis 挂）→ rethrow 信封（不报假成功）', async () => {
    const u = await login(request, 'user1', 'pw-user1-secure')
    await request.post('/api/v1/containers').set(bearer(u.access)).send({ name: 'u-qfail' })
    await provision('u-qfail')
    queue.failEnqueueDelete = true // 模拟 Redis 挂
    const del = await request.delete('/api/v1/containers/u-qfail').set(bearer(u.access))
    // 入队失败 → 信封错误（20045 CLEANUP_FAILED 或 90000），非 code:0 假成功
    expect(del.body.code).not.toBe(0)
    expect(del.body.data).toBeNull()
    // 行保留（未被删），客户端可重试
    expect(await ctx.prisma.container.findUnique({ where: { name: 'u-qfail' } })).not.toBeNull()
  })

  it('凭证零落盘：响应无 token 明文', async () => {
    const u = await login(request, 'user1', 'pw-user1-secure')
    const res = await request.get('/api/v1/containers').set(bearer(u.access))
    expect(JSON.stringify(res.body)).not.toMatch(/[A-Za-z0-9_-]{32,}/)
  })
})
