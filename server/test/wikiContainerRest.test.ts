// wiki REST 存储换轨 S1（#784 AC「零初始化起容器后 wiki 域 REST 读写通」的信封级接线面）：
// 路由 ↔ wiki 容器 ensure ↔ serviceFor(ownerId) 三点接线直锁。ensure 与 serviceFactory 均注入
// fake（存储适配器行为由 wikiDockerFs.test.ts / wikiContainerLifecycle.test.ts 单测覆盖）。
// 重点锁顺序契约：name 校验（90002）与归属校验（20040）先于 ensure——未授权/非法探测不建容器。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import { FakeWikiFileSystem } from './fakes'
import { WikiService } from '../src/wiki/service'

let seq = 0

describe('wiki REST 存储换轨新 wiki 容器（#784 · S1 信封级）', () => {
  let ctx: TestContext
  // ensure 调用记录：ownerId → 次数
  const ensureCalls: string[] = []
  // serviceFor 收到的 inst（断言 ownerId 透传）
  const serviceForInsts: { name: string; ownerId: string }[] = []
  let adminToken: string
  let userToken: string
  let adminId: string
  let userId: string
  let demoName: string

  beforeAll(async () => {
    ctx = await setupTestApp({
      wiki: {
        wikiContainers: {
          ensure: async (ownerId) => {
            ensureCalls.push(ownerId)
          },
        },
        serviceFor: (inst) => {
          serviceForInsts.push({ ...inst })
          return new WikiService(new FakeWikiFileSystem())
        },
      },
    })
    adminId = (await seedAdmin(ctx.prisma, 'root', 'pw-admin-secure')).id
    const u = await seedUser(ctx.prisma, 'wuser', 'pw-wuser-secure')
    userId = u.id
    adminToken = (await login(ctx.request, 'root', 'pw-admin-secure')).access!
    userToken = (await login(ctx.request, 'wuser', 'pw-wuser-secure')).access!
    seq += 1
    demoName = `demo${seq}`
    await ctx.prisma.container.create({
      data: { name: demoName, port: 19000 + seq, ownerId: userId, token: 't', homeDir: '/unused', image: 'img', status: 'running' },
    })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('GET tree：归属校验后 ensure(ownerId) → serviceFor 收 {name, ownerId}', async () => {
    const res = await ctx.request.get(`/api/v1/containers/${demoName}/wiki/tree`).set(bearer(userToken))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(ensureCalls).toEqual([userId]) // ensure 的是 wiki 容器属主（= Container 行 ownerId）
    expect(serviceForInsts.at(-1)).toMatchObject({ name: demoName, ownerId: userId })
    expect(res.body.data).toEqual({ groups: [] }) // 零初始化空树合法初态
  })

  it('越权（user 读他人容器）→ 20040，且不 ensure（未授权探测不建容器）', async () => {
    seq += 1
    const other = `demo${seq}`
    await ctx.prisma.container.create({
      data: { name: other, port: 19000 + seq, ownerId: adminId, token: 't', homeDir: '/unused', image: 'img', status: 'running' },
    })
    const callsBefore = ensureCalls.length
    const res = await ctx.request.get(`/api/v1/containers/${other}/wiki/tree`).set(bearer(userToken))
    expect(res.body.code).toBe(20040)
    expect(ensureCalls.length).toBe(callsBefore)
  })

  it('容器不存在 → 20040，且不 ensure（同码防探测；无归属凭据不触碰编排面）', async () => {
    const callsBefore = ensureCalls.length
    const res = await ctx.request.get('/api/v1/containers/nosuch/wiki/tree').set(bearer(userToken))
    expect(res.body.code).toBe(20040)
    expect(ensureCalls.length).toBe(callsBefore)
  })

  it('name 非法 → 90002，先于 ensure（顺序陷阱 #315 §0）', async () => {
    const callsBefore = ensureCalls.length
    const res = await ctx.request.get('/api/v1/containers/BAD_NAME/wiki/tree').set(bearer(userToken))
    expect(res.body.code).toBe(90002)
    expect(res.body.data?.name).toBeTruthy()
    expect(ensureCalls.length).toBe(callsBefore)
  })

  it('admin 跨用户读 → ensure 该行 ownerId（admin 全放行，wiki 容器随行主）', async () => {
    const callsBefore = ensureCalls.length
    const res = await ctx.request.get(`/api/v1/containers/${demoName}/wiki/tree`).set(bearer(adminToken))
    expect(res.status).toBe(200)
    expect(ensureCalls.slice(callsBefore)).toEqual([userId])
  })

  it('写面同接线：POST page 前置 ensure（每操作一次，create/health 合一面）', async () => {
    const callsBefore = ensureCalls.length
    const res = await ctx.request
      .post(`/api/v1/containers/${demoName}/wiki/page`)
      .set(bearer(userToken))
      .send({ path: 'notes/a.md', content: '# A\n' })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(ensureCalls.slice(callsBefore)).toEqual([userId])
  })
})
