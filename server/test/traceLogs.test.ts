import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'

describe('text trace logs admin API', () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestApp()
    const admin = await seedAdmin(ctx.prisma)
    const user = await seedUser(ctx.prisma, 'trace-user', 'pw-trace-secure')
    await ctx.prisma.textTraceLog.createMany({
      data: [
        {
          traceId: 'trace-alpha',
          userId: user.id,
          username: user.username,
          ipAddress: '127.0.0.1',
          containerName: 'alpha',
          sessionKey: 'sk-1',
          runId: 'run-1',
          inputText: '学习的技术',
          outputText: '学习技术的笔记',
          outputHash: 'hash-alpha',
          status: 'success',
        },
        {
          traceId: 'trace-beta',
          userId: admin.id,
          username: admin.username,
          ipAddress: '10.0.0.8',
          containerName: 'beta',
          sessionKey: 'sk-2',
          runId: 'run-2',
          inputText: '失败输入',
          outputText: '模型失败',
          outputHash: 'hash-beta',
          status: 'failed',
        },
      ],
    })
  })

  afterAll(async () => {
    await ctx.cleanup()
  })

  it('admin lists trace logs with searchable user/ip/content/status fields', async () => {
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const res = await ctx.request
      .get('/api/v1/trace-logs?ip=127.0&content=笔记&status=success')
      .set(bearer(admin.access))

    expect(res.body.code).toBe(0)
    expect(res.body.data.total).toBe(1)
    expect(res.body.data.logs[0]).toMatchObject({
      traceId: 'trace-alpha',
      username: 'trace-user',
      ipAddress: '127.0.0.1',
      inputText: '学习的技术',
      outputText: '学习技术的笔记',
      status: 'success',
    })
  })

  it('non-admin cannot list trace logs', async () => {
    const plain = await login(ctx.request, 'trace-user', 'pw-trace-secure')
    const res = await ctx.request.get('/api/v1/trace-logs').set(bearer(plain.access))
    expect(res.body.code).toBe(10041)
  })
})
