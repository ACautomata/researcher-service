import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { bearer, login, seedUser } from './helpers'
import { createChaoxingTools } from '../src/chaoxing/tools'
import { ChaoxingService } from '../src/chaoxing/service'
import type { ChaoxingRemote } from '../src/chaoxing/remote'

describe('Agent 超星学习工具', () => {
  let ctx: TestContext
  let service: ChaoxingService
  let ownerId: string
  let otherId: string
  let auth: Record<string, string>
  const options = { clientId: 'test', clientSecret: 'secret', redirectUri: 'https://panel.example/callback', credentialSecret: 'test-encryption-root-for-chaoxing-32' }
  const remote: ChaoxingRemote = {
    async exchange() { return { access_token: 'token', token_type: 'Bearer' } },
    async refresh() { throw new Error('unsupported') },
    async courses() { return { rows: [{ id: 'c', name: '数学' }], truncated: false } },
    async inspect() { return { tools: [], capabilities: [] } },
    async learn() { return { resources: [{ id: 'r', name: '课件', kind: 'resource', courseId: 'c', courseName: '数学', text: '梯度是方向导数最大值的方向。', url: 'https://mooc.chaoxing.com/r' }], limitations: [] } },
  }
  beforeAll(async () => {
    ctx = await setupTestApp({ chaoxing: { options, remote } })
    ownerId = (await seedUser(ctx.prisma, 'tool-student', 'student-password')).id
    otherId = (await seedUser(ctx.prisma, 'tool-other', 'student-password')).id
    service = new ChaoxingService(ctx.prisma, options, remote)
    auth = bearer((await login(ctx.request, 'tool-student', 'student-password')).access)
    const start = await ctx.request.post('/api/v1/integrations/chaoxing/authorize').set(auth).send({})
    await ctx.request.get('/api/v1/integrations/chaoxing/callback').set('Cookie', `chaoxing_oauth=${new URL(start.body.data.url).searchParams.get('state')}`).query({ state: new URL(start.body.data.url).searchParams.get('state'), code: 'code' })
  })
  afterAll(async () => ctx?.cleanup())
  it('会话课程可选、持久化且不可越权修改', async () => {
    await ctx.prisma.session.create({ data: { id: 'scope-session', ownerId, containerId: '' } })
    const path = '/api/v1/integrations/chaoxing/sessions/scope-session/scope'
    expect((await ctx.request.put(path).set(auth).send({ courseId: 'c' })).body.code).toBe(0)
    expect((await ctx.request.get(path).set(auth)).body.data.courseId).toBe('c')
    expect((await ctx.request.put(path).set(auth).send({ courseId: 'not-accessible' })).body.code).not.toBe(0)
    expect((await ctx.request.put(path).set(auth).send({ courseId: null })).body.code).toBe(0)
    expect((await ctx.request.get(path).set(auth)).body.data.courseId).toBeNull()
  })
  it('未选课可调用，身份由运行时绑定，未绑定用户获得引导', async () => {
    const [tool] = createChaoxingTools(service, ownerId)
    const result = JSON.parse(await tool!.invoke({ topic: '梯度' }))
    expect(result.resources[0]).toMatchObject({ courseName: '数学', url: 'https://mooc.chaoxing.com/r' })
    const [otherTool] = createChaoxingTools(service, otherId)
    const denied = JSON.parse(await otherTool!.invoke({ topic: '梯度' }))
    expect(denied.ok).toBe(false)
    expect(denied.settingsUrl).toBe('/settings')
    await expect(tool!.invoke({ topic: '梯度', ownerId: otherId })).rejects.toThrow()
  })
})
