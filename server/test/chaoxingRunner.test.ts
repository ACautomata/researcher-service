import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, login, bearer } from './helpers'
import { ScriptedChatModel, toolCallAi, fakePrimitives, CollectingHub } from './runnerFakes'
import { ChaoxingService } from '../src/chaoxing/service'
import type { ChaoxingRemote } from '../src/chaoxing/remote'
import { ProviderRegistry } from '../src/runner/providerRegistry'
import { PrismaCheckpointSaver } from '../src/runner/persistence/prismaCheckpointSaver'
import { ConcurrencyGate } from '../src/runner/concurrency'
import { RunService } from '../src/runner/runtime/runService'
import { createPluginRuntime } from '../src/plugins/surface'

describe('学习工具在真实 Agent 图中的接线与课程快照', () => {
  let ctx: TestContext
  let runner: RunService
  let ownerId: string
  let auth: Record<string, string>
  let started: (() => void) | undefined
  let release: (() => void) | undefined
  const seen: (string | undefined)[] = []
  const model = new ScriptedChatModel([
    toolCallAi('learning-1', 'chaoxing_learning_resources', { topic: '梯度' }),
    toolCallAi('learning-2', 'chaoxing_learning_resources', { topic: '学习率', courseId: 'c2' }),
    new AIMessage('已提供课程一来源。'),
    toolCallAi('learning-3', 'chaoxing_learning_resources', { topic: '梯度' }),
    new AIMessage('已提供课程二来源。'),
  ])
  const hub = new CollectingHub()
  const options = { clientId: 'test', clientSecret: 'secret', credentialSecret: 'independent-chaoxing-secret-32-chars', redirectUri: 'https://panel.example/callback' }
  const remote: ChaoxingRemote = {
    async exchange() { return { access_token: 'authorized-access', token_type: 'Bearer' } },
    async refresh() { throw new Error('unsupported') },
    async inspect() { return { tools: [], capabilities: [] } },
    async courses() { return { rows: [{ id: 'c1', name: '课程一' }, { id: 'c2', name: '课程二' }], truncated: false } },
    async learn(_token, _topic, courseId) {
      seen.push(courseId)
      if (seen.length === 1) { started?.(); await new Promise<void>(resolve => { release = resolve }) }
      return { resources: [{ id: 'r', name: '课件', kind: 'resource', courseId: courseId!, courseName: courseId === 'c1' ? '课程一' : '课程二', text: '学习率控制迭代步长。', url: 'https://mooc.chaoxing.com/r' }], limitations: [] }
    },
  }
  beforeAll(async () => {
    ctx = await setupTestApp({ chaoxing: { options, remote } })
    ownerId = (await seedUser(ctx.prisma, 'graph-student', 'student-password')).id
    auth = bearer((await login(ctx.request, 'graph-student', 'student-password')).access)
    await ctx.prisma.session.create({ data: { id: 'learning-session', ownerId, containerId: 'lab' } })
    const start = await ctx.request.post('/api/v1/integrations/chaoxing/authorize').set(auth).send({})
    const state = new URL(start.body.data.url).searchParams.get('state')
    await ctx.request.get('/api/v1/integrations/chaoxing/callback').set('Cookie', `chaoxing_oauth=${state}`).query({ state, code: 'code' })
    const registry = new ProviderRegistry(ctx.prisma, { llmApiKey: 'test-key', modelFactory: async () => model })
    runner = new RunService({ prisma: ctx.prisma, registry, saver: new PrismaCheckpointSaver(ctx.prisma), gate: new ConcurrencyGate({ globalLimit: 2, loadUserLimit: async () => 2 }), hub, primitives: fakePrimitives().primitives, resolveWikiContainer: () => 'wiki', plugins: createPluginRuntime({ manifests: [], config: {} }), chaoxing: new ChaoxingService(ctx.prisma, options, remote) })
  })
  afterAll(async () => ctx?.cleanup())
  it('范围变更仅下一 run 生效；模型能收到自动推荐指导、正文和真实来源', async () => {
    const path = '/api/v1/integrations/chaoxing/sessions/learning-session/scope'
    await ctx.request.put(path).set(auth).send({ courseId: 'c1' })
    const learning = new Promise<void>(resolve => { started = resolve })
    const first = runner.execute({ runId: 'learn-run-1', sessionId: 'learning-session', ownerId, username: 'graph-student', kind: 'message', content: '解释梯度' })
    await learning
    expect((await ctx.request.put(path).set(auth).send({ courseId: 'c2' })).body.code).toBe(0)
    release!()
    await first
    expect(seen).toEqual(['c1', 'c1'])
    expect(hub.types()).toContain('run.completed')
    const messages = JSON.stringify(model.receivedMessages)
    expect(messages).toContain('不要求先选课程')
    expect(messages).toContain('学习率控制迭代步长')
    expect(messages).toContain('https://mooc.chaoxing.com/r')
    await runner.execute({ runId: 'learn-run-2', sessionId: 'learning-session', ownerId, username: 'graph-student', kind: 'message', content: '继续学习' })
    expect(seen).toEqual(['c1', 'c1', 'c2'])
  })
})
