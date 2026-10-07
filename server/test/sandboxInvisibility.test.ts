// 沙箱对容器列表隐身（#776 验收 · story 58「全程对我隐身」· S1 信封级）。
// 语义底座：沙箱是纯 session 实现细节——无 containers 表行（生命周期不走 fleet 5 态机）、
// 不打 app=openclaw-fleet 标签（fleet listFleet 标签过滤天然不可见）。本测试用共享同一
// FakeRuntime 的编排器挂 list API，同时沙箱活在 FakeSandboxRuntime 的 daemon 视图里——
// 断言「沙箱已存在」而「容器列表 API 不含它」。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import supertest from 'supertest'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, login, bearer } from './helpers'
import { FakeSandboxRuntime } from './fakeSandboxRuntime'
import { makeFleetTest } from './fleetTestUtils'
import { SandboxLifecycle } from '../src/sandboxes/lifecycle'
import { DockerSandboxRuntime } from '../src/sandboxes/dockerRuntime'
import { KIND_SANDBOX, LABEL_KIND_KEY, LABEL_SESSION_KEY, LABEL_APP_KEY } from '../src/containers/constants'
import { SANDBOX_LIMITS } from '../src/sandboxes/values'
import { createApp } from '../src/app'

describe('沙箱对容器列表隐身（#776 · S1）', () => {
  let ctx: TestContext
  let fleet: ReturnType<typeof makeFleetTest>
  let sandboxRuntime: FakeSandboxRuntime

  beforeAll(async () => {
    ctx = await setupTestApp()
    fleet = makeFleetTest(ctx.prisma)
    sandboxRuntime = new FakeSandboxRuntime()
    // 重建 app 注入 orchestrator + runtime + files（fleetTestUtils 先于 setupTestApp 建表完成）
    const app = createApp({
      prisma: ctx.prisma,
      orchestrator: fleet.orch,
      files: { archive: fleet.archive },
    })
    ctx.request = supertest(app) as unknown as TestContext['request']
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('沙箱已在 daemon 活着（沙箱视图），容器列表 API 与 fleet daemon 视图均不含它', async () => {
    const u = await seedUser(ctx.prisma, 'sinv1', 'pw-sinv1-secure')
    // 一个 legacy fleet 容器（列表里该有它）
    const inst = await fleet.orch.createReserve('sinv-legacy', u.id)
    await fleet.orch.createComplete(inst, true)
    // 沙箱存在性证据（沙箱 daemon 视图）
    const sandboxLifecycle = new SandboxLifecycle(sandboxRuntime, { image: 'busybox:1.36' })
    await sandboxLifecycle.ensure('csinv0001')
    expect(sandboxRuntime.containers.has('csinv0001')).toBe(true)

    const l = await login(ctx.request, 'sinv1', 'pw-sinv1-secure')
    const res = await ctx.request.get('/api/v1/containers').set(bearer(l.access))
    expect(res.body.code).toBe(0)
    const names = res.body.data.map((c: { name: string }) => c.name)
    expect(names).toContain('sinv-legacy') // legacy 容器照常可见
    expect(names).not.toContain('researcher-sandbox-csinv0001') // 沙箱对列表隐身（无行 + 无标签）
    // fleet daemon 视图同样不含沙箱（listFleet 的 app 标签过滤语义）
    const fleetView = await fleet.runtime.listFleet()
    expect(fleetView.map((c) => c.name)).not.toContain('researcher-sandbox-csinv0001')
  })

  it('隐身语义来源：沙箱容器带 kind=sandbox/session 标签，不带 fleet app 标签', () => {
    // buildSandboxCreateOptions 是纯函数——标签集即 daemon 侧隐身判定的依据
    const opts = new DockerSandboxRuntime(() => null as never).buildSandboxCreateOptions({
      sessionId: 'csinv0002',
      image: 'busybox:1.36',
      limits: SANDBOX_LIMITS,
    })
    expect(opts.Labels).toMatchObject({ [LABEL_KIND_KEY]: KIND_SANDBOX, [LABEL_SESSION_KEY]: 'csinv0002' })
    expect(Object.keys(opts.Labels ?? {})).not.toContain(LABEL_APP_KEY) // app=openclaw-fleet 过滤不命中
  })
})
