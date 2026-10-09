// wiki REST 存储换轨 S1（#784 AC「零初始化起容器后 wiki 域 REST 读写通」的信封级接线面）：
// 路由 ↔ wiki 容器 ensure ↔ serviceFor(ownerId) 三点接线直锁。ensure 与 serviceFactory 均注入
// fake（存储适配器行为由 wikiDockerFs.test.ts / wikiContainerLifecycle.test.ts 单测覆盖）。
// #856（退役①）：ownerId 直取认证身份，路由层零容器行查询。重点锁顺序契约新形态：
// 认证（10001）与 path/body 校验（90002）先于 ensure——未授权/非法探测不建容器；
// ownerId 无客户端覆写面，跨用户隔离由派生封闭保证（各用户只 ensure/寻址本人 wiki 容器）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import { FakeWikiFileSystem } from './fakes'
import { WikiService } from '../src/wiki/service'

describe('wiki REST 存储换轨新 wiki 容器（#784 · S1 信封级；#856 owner 级）', () => {
  let ctx: TestContext
  // ensure 调用记录（ownerId 序列）
  const ensureCalls: string[] = []
  // serviceFor 收到的 ownerId（断言认证身份直透传）
  const serviceForOwners: string[] = []
  let adminToken: string
  let adminId: string
  let userToken: string
  let userId: string

  beforeAll(async () => {
    ctx = await setupTestApp({
      wiki: {
        wikiContainers: {
          ensure: async (ownerId) => {
            ensureCalls.push(ownerId)
          },
        },
        serviceFor: (ownerId) => {
          serviceForOwners.push(ownerId)
          return new WikiService(new FakeWikiFileSystem())
        },
      },
    })
    const a = await seedAdmin(ctx.prisma, 'root', 'pw-admin-secure')
    adminId = a.id
    const u = await seedUser(ctx.prisma, 'wuser', 'pw-wuser-secure')
    userId = u.id
    adminToken = (await login(ctx.request, 'root', 'pw-admin-secure')).access!
    userToken = (await login(ctx.request, 'wuser', 'pw-wuser-secure')).access!
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('GET tree：ensure(认证身份) → serviceFor 收同一 ownerId（零容器行查询）', async () => {
    const res = await ctx.request.get('/api/v1/wiki/tree').set(bearer(userToken))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(ensureCalls).toEqual([userId]) // ensure 的是请求者本人的 wiki 容器
    expect(serviceForOwners.at(-1)).toBe(userId)
    expect(res.body.data).toEqual({ groups: [] }) // 零初始化空树合法初态
  })

  it('未认证 → 10001，且不 ensure（未授权探测不建容器——「归属先于 ensure」新形态）', async () => {
    const callsBefore = ensureCalls.length
    const res = await ctx.request.get('/api/v1/wiki/tree')
    expect(res.body.code).toBe(10001)
    expect(ensureCalls.length).toBe(callsBefore)
  })

  it('path 非法 → 90002，先于 ensure（非法请求不触碰编排面，对齐 #315 §0 顺序陷阱）', async () => {
    const callsBefore = ensureCalls.length
    const res = await ctx.request.get('/api/v1/wiki/page?path=../../evil.md').set(bearer(userToken))
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('path')
    expect(ensureCalls.length).toBe(callsBefore)
  })

  it('写面退役（#758 Q3）：POST /wiki/page → 90005 路由不存在，且不触达 ensure（编排面无副作用）', async () => {
    const callsBefore = ensureCalls.length
    const res = await ctx.request
      .post('/api/v1/wiki/page')
      .set(bearer(userToken))
      .send({ path: 'notes/a.md', content: '# A\n' })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(90005) // 路由不存在（写面收归 agent，不经 REST）
    expect(ensureCalls.length).toBe(callsBefore) // 未路由到的请求不建容器
  })

  it('admin 亦只操作本人 wiki（owner 级无跨用户覆写面）：ensure adminId 而非他人', async () => {
    const callsBefore = ensureCalls.length
    const res = await ctx.request.get('/api/v1/wiki/tree').set(bearer(adminToken))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(ensureCalls.slice(callsBefore)).toEqual([adminId])
  })

  it('两用户互不串线：各自请求 ensure 各自 ownerId，序列无交叉', async () => {
    const callsBefore = ensureCalls.length
    await ctx.request.get('/api/v1/wiki/tree').set(bearer(userToken))
    await ctx.request.get('/api/v1/wiki/tree').set(bearer(adminToken))
    expect(ensureCalls.slice(callsBefore)).toEqual([userId, adminId])
  })
})
