// wiki 认证单链测试（codex PR#346 P2；#856 后 wiki 独挂 /api/v1/wiki——与 containers router
// 不再共享挂载前缀，双重认证的结构性成因已消失，本用例降级为回归守卫：wiki 请求全程仍只触发
// 一次 authenticate（一次 findUnique），防未来挂载方式回退引入重复认证）。
// #856：无容器行前置，seedUser 即达（ownerId 直取认证身份）。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, login, bearer } from './helpers'
import { FakeWikiFileSystem } from './fakes'
import { WikiService } from '../src/wiki/service'
import * as authModule from '../src/auth/authenticate'

describe('wiki 认证单链（#856 owner 级独立挂载）', () => {
  let ctx: TestContext

  beforeAll(async () => {
    // 内存 fake 存储；#856 起无需容器行与编排器。
    const serviceFor = () => new WikiService(new FakeWikiFileSystem({ 'concepts/a.md': '# A\n' }))
    ctx = await setupTestApp({ wiki: { serviceFor } })
    await seedUser(ctx.prisma, 'usingle', 'pw-usingle-secure')
  })

  afterAll(async () => {
    await ctx.cleanup()
  })

  it('wiki 请求全程只触发一次 authenticate（不重复查用户表）', async () => {
    const l = await login(ctx.request, 'usingle', 'pw-usingle-secure')
    const spy = vi.spyOn(authModule, 'authenticate')
    spy.mockClear()
    const res = await ctx.request.get('/api/v1/wiki/tree').set(bearer(l.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data.groups).toBeDefined()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
