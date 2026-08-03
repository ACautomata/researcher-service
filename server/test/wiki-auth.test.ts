// wiki 认证单链测试（codex PR#346 P2）：生产下 orchestrator 与 wiki 同时挂载在 /api/v1/containers，
// 各自 router.use(requireAuth) —— wiki 请求会先过 containers router 的认证、落到 wiki router 再认证一次
// （每次 authenticate() 都验 JWT + 查用户表）。回归：wiki 请求全程只触发一次 authenticate（一次 findUnique）。
// 装配对齐 containers.test.ts：先建临时 app 拿 prisma，再装 orchestrator + wiki 重建 app（同一 DB）。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, login, bearer } from './helpers'
import { makeFleetTest } from './fleetTestUtils'
import * as authModule from '../src/auth/authenticate'

describe('wiki 认证单链（生产 orchestrator + wiki 同挂；codex PR#346 P2）', () => {
  let ctx: TestContext
  let name: string

  beforeAll(async () => {
    ctx = await setupTestApp({ wiki: { compile: { trigger: () => {} } } })
    const fl = makeFleetTest(ctx.prisma)
    const { createApp } = await import('../src/app')
    const supertest = (await import('supertest')).default
    const app = createApp({ prisma: ctx.prisma, orchestrator: fl.orch, wiki: { compile: { trigger: () => {} } } })
    ctx.request = supertest(app) as unknown as TestContext['request']

    const u = await seedUser(ctx.prisma, 'usingle', 'pw-usingle-secure')
    const home = mkdtempSync(path.join(tmpdir(), 'wiki-auth-'))
    mkdirSync(path.join(home, 'wiki', 'main', 'concepts'), { recursive: true })
    writeFileSync(path.join(home, 'wiki', 'main', 'concepts', 'a.md'), '# A\n')
    name = 'asingle'
    await ctx.prisma.container.create({
      data: { name, port: 19999, ownerId: u.id, token: 't', homeDir: home, image: 'img', status: 'running' },
    })
  })

  afterAll(async () => {
    await ctx.cleanup()
  })

  it('wiki 请求全程只触发一次 authenticate（不双重查用户表）', async () => {
    const l = await login(ctx.request, 'usingle', 'pw-usingle-secure')
    const spy = vi.spyOn(authModule, 'authenticate')
    spy.mockClear()
    const res = await ctx.request.get(`/api/v1/containers/${name}/wiki/tree`).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data.groups).toBeDefined()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
