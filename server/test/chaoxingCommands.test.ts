// 超星内置手动命令（/course-search、/topic-search）：从消息 API 提交，确定性直达学习领域服务。
// 仅替换超星远端传输；会话认证、幂等、门禁、run 生命周期与落库使用真实实现。
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import supertest from 'supertest'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import { createPrismaClient } from '../src/prisma'
import { createApp } from '../src/app'
import { signAccessToken } from '../src/auth/tokens'
import { StreamHub } from '../src/events/hub'
import type { CatalogEvent } from '../src/events/logic'
import { RunService } from '../src/runner/runtime/runService'
import { ProviderRegistry } from '../src/runner/providerRegistry'
import { ConcurrencyGate } from '../src/runner/concurrency'
import { PrismaCheckpointSaver } from '../src/runner/persistence/prismaCheckpointSaver'
import { SessionService } from '../src/sessions/service'
import { createPluginRuntime } from '../src/plugins/surface'
import { encryptCredential } from '../src/models/cipher'
import { ChaoxingService } from '../src/chaoxing/service'
import {
  ChaoxingConfigError,
  type ChaoxingQueryTarget,
  type ChaoxingRemote,
  type LearningResult,
} from '../src/chaoxing/remote'
import { ScriptedChatModel, fakePrimitives } from './runnerFakes'
import { seedUser } from './helpers'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

class CapturingModel extends ScriptedChatModel {
  readonly inputs: string[] = []
  override async _generate(messages: BaseMessage[]) {
    const input = JSON.stringify(messages.map(message => ({type: message.getType(), content: message.content})))
    this.inputs.push(typeof input === 'string' ? input : '')
    return { generations: [{ message: new AIMessage({ content: 'ack' }), text: 'ack' }] }
  }
}

const options = {
  clientId: 'command-client',
  clientSecret: 'command-secret',
  redirectUri: 'https://panel.example/api/v1/integrations/chaoxing/callback',
  credentialSecret: 'chaoxing-command-test-secret-at-least-32-chars',
}

interface Call { token: string; topic: string; courseId?: string; target?: ChaoxingQueryTarget; classId?: string }

function fakeRemote() {
  const calls: Call[] = []
  let result: LearningResult = {
    resources: [{ id: 'r1', name: '梯度下降课件', kind: 'resource', courseId: 'c1', courseName: '机器学习', text: '学习率控制迭代步长。', url: 'https://mooc.chaoxing.com/resource/1' }],
    limitations: [],
  }
  let error: Error | undefined
  const remote: ChaoxingRemote = {
    async exchange() { return { access_token: 'exchange-token', token_type: 'Bearer', expires_in: 3600 } },
    async refresh() { return { access_token: 'refreshed-token', token_type: 'Bearer', expires_in: 3600 } },
    async inspect() { return { tools: [], capabilities: [] } },
    async learn(token, topic, courseId, _signal, target, classId) {
      calls.push({ token, topic, ...(courseId ? { courseId } : {}), ...(target ? { target } : {}), ...(classId ? { classId } : {}) })
      if (error) throw error
      return result
    },
  }
  return {
    remote,
    calls,
    setResult(next: LearningResult) { result = next },
    failWith(next: Error) { error = next },
  }
}

describe('超星内置手动命令', () => {
  async function harness({ configured = true } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'chaoxing-cmd-'))
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma/init.sql'), 'utf8'))
    sqlite.close()
    const prisma = createPrismaClient(`file:${dbPath}`)
    const owner = await seedUser(prisma, 'cx-cmd-user', 'cx-cmd-password')
    await prisma.modelProvider.create({ data: {
      ownerId: owner.id, providerId: 'cmd-provider', presetId: 'openai',
      modelsJson: JSON.stringify([{ id: 'model-x' }]),
    } })
    const hub = new StreamHub()
    const events: CatalogEvent[] = []
    let onStarted: (() => void) | undefined
    hub.register(owner.id, { send: frame => {
      const data = /^data: (.+)$/m.exec(frame)?.[1]
      if (data) {
        const event = JSON.parse(data) as CatalogEvent
        events.push(event)
        if (event.type === 'run.started') onStarted?.()
      }
      return true
    }, close: () => {} })
    const fake = fakeRemote()
    const chaoxing = configured
      ? new ChaoxingService(prisma, options, fake.remote)
      : new ChaoxingService(prisma)
    const model = new CapturingModel([])
    const plugins = createPluginRuntime({ manifests: [], config: {} })
    const service = new RunService({
      prisma, hub, gate: new ConcurrencyGate({ globalLimit: 4, loadUserLimit: async () => 4 }),
      saver: new PrismaCheckpointSaver(prisma),
      registry: new ProviderRegistry(prisma, { llmApiKey: 'fake', modelFactory: async () => model }),
      primitives: fakePrimitives().primitives,
      resolveWikiContainer: () => 'researcher-wiki-cmd',
      plugins,
      ...(configured ? { chaoxing } : {}),
    })
    const executions: Promise<void>[] = []
    const dispatch = async (command: Parameters<RunService['execute']>[0]) => {
      const execution = service.execute(command)
      execution.catch(() => {})
      executions.push(execution)
    }
    const sessions = new SessionService({
      prisma, hub, runService: service, dispatch, plugins,
      chaoxing: { status: (ownerId: string) => chaoxing.status(ownerId) },
    })
    service.setRecordTurn(payload => sessions.recordTurn(payload))
    const request = supertest(createApp({ prisma, events: { hub }, sessions: { service: sessions } }))
    const auth = { Authorization: `Bearer ${await signAccessToken(owner.id)}` }
    const sessionId = (await request.post('/api/v1/sessions').set(auth).send({ title: 'cx-cmd' })).body.data.id as string
    cleanups.push(async () => { service.dispose(); await prisma.$disconnect() })
    const settle = async () => { let n = 0; while (n < executions.length) { const current = executions.slice(n); n = executions.length; await Promise.all(current) } }
    const send = (content: string, key: string) => request.post(`/api/v1/sessions/${sessionId}/messages`).set(auth).set('Idempotency-Key', key).send({ content })
    const projection = async () => (await request.get(`/api/v1/sessions/${sessionId}/messages`).set(auth)).body.data as {
      messages: Array<{ role: string; content: string; tools?: Array<{ name: string; state: string }> }>
    }
    async function bind() {
      await prisma.chaoxingBinding.create({ data: {
        ownerId: owner.id,
        generation: randomUUID(),
        tokenCipher: encryptCredential(JSON.stringify({ access_token: 'owner-token', token_type: 'Bearer' }), options.credentialSecret),
        expiresAt: new Date(Date.now() + 3_600_000),
      } })
    }
    return { prisma, owner, sessionId, events, settle, send, projection, bind, model, calls: fake.calls, fake, service, onStarted(callback: () => void) { onStarted = callback } }
  }

  it('手动命令可显式提供课程和学生班级，不依赖课程发现或模型', async () => {
    const h = await harness()
    await h.bind()
    expect((await h.send('/course-search --course-id 123 --class-id 456 梯度 下降', '21'.repeat(16))).body.code).toBe(0)
    await h.settle()
    expect(h.calls).toEqual([{ token: 'owner-token', topic: '梯度 下降', courseId: '123', classId: '456', target: 'resources' }])
    expect((await h.send('/topic-search --course-id 123 导数', '22'.repeat(16))).body.code).toBe(0)
    await h.settle()
    expect(h.calls[1]).toEqual({ token: 'owner-token', topic: '导数', courseId: '123', target: 'topics' })
    expect(h.model.inputs).toEqual([])
    expect((await h.prisma.session.findUnique({ where: { id: h.sessionId } }))?.learningCourseId).toBeNull()
  })

  it('手动命令拒绝无效或重复的课程班级参数，且不创建运行', async () => {
    const h = await harness()
    await h.bind()
    for (const args of ['--course-id bad 梯度', '--class-id 0 梯度', '--course-id 123 --course-id 456 梯度', '--course-id 123']) {
      expect((await h.send(`/course-search ${args}`, randomUUID())).body.code).toBe(90002)
    }
    expect(h.calls).toEqual([])
  })

  it('资料命令固定 resources 目标、复用会话课程范围、零模型调用且结果入历史', async () => {
    const h = await harness()
    await h.bind()
    await h.prisma.session.update({ where: { id: h.sessionId }, data: { learningCourseId: 'c1' } })
    expect((await h.send('/course-search 梯度 下降', 'a'.repeat(32))).body.code).toBe(0)
    await h.settle()
    expect(h.model.inputs).toEqual([])
    expect(h.calls).toEqual([{ token: 'owner-token', topic: '梯度 下降', courseId: 'c1', target: 'resources' }])
    const start = h.events.find(event => event.type === 'tool.start')
    expect(start).toMatchObject({ payload: { name: 'chaoxing_course_search' } })
    const end = h.events.find(event => event.type === 'tool.end')
    expect(end).toMatchObject({ payload: { name: 'chaoxing_course_search', state: 'success' } })
    expect((end!.payload as { details: string }).details).toContain('梯度下降课件')
    const delta = h.events.filter(event => event.type === 'text.delta').map(event => (event.payload as { delta: string }).delta).join('')
    expect(delta).toContain('**超星课程资料**（1 条）')
    expect(delta).toContain('https://mooc.chaoxing.com/resource/1')
    const projection = await h.projection()
    expect(projection.messages[0]).toMatchObject({ role: 'user', content: '/course-search 梯度 下降' })
    expect(projection.messages.at(-1)).toMatchObject({ role: 'assistant' })
    expect(projection.messages.at(-1)!.content).toContain('梯度下降课件')
    expect(projection.messages.at(-1)!.tools?.[0]).toMatchObject({ name: 'chaoxing_course_search', state: 'success' })
    // 命令本身不修改课程范围
    expect((await h.prisma.session.findUnique({ where: { id: h.sessionId } }))?.learningCourseId).toBe('c1')
  }, 20_000)

  it('知识点命令固定 topics 目标，只使用知识点工具面', async () => {
    const h = await harness()
    await h.bind()
    h.fake.setResult({ resources: [{ id: 't1', name: '导数', kind: 'topic', courseId: 'c1', courseName: '数学', text: '导数的定义。' }], limitations: [] })
    expect((await h.send('/topic-search 导数', 'b'.repeat(32))).body.code).toBe(0)
    await h.settle()
    expect(h.model.inputs).toEqual([])
    expect(h.calls).toEqual([{ token: 'owner-token', topic: '导数', target: 'topics' }])
    const end = h.events.find(event => event.type === 'tool.end')
    expect(end).toMatchObject({ payload: { name: 'chaoxing_topic_search', state: 'success' } })
    const delta = h.events.filter(event => event.type === 'text.delta').map(event => (event.payload as { delta: string }).delta).join('')
    expect(delta).toContain('**超星已有知识点**（1 条）')
    expect(delta).toContain('未提供')
  }, 20_000)

  it('0 命中明确说明未找到，不伪造结果', async () => {
    const h = await harness()
    await h.bind()
    h.fake.setResult({ resources: [], limitations: ['部分资源未返回可访问链接，不应编造链接'] })
    expect((await h.send('/course-search 不存在的内容', 'c'.repeat(32))).body.code).toBe(0)
    await h.settle()
    const delta = h.events.filter(event => event.type === 'text.delta').map(event => (event.payload as { delta: string }).delta).join('')
    expect(delta).toContain('未找到与「不存在的内容」相关的超星课程资料')
    expect(delta).toContain('不应编造链接')
    const projection = await h.projection()
    expect(projection.messages.at(-1)!.content).toContain('未找到')
  }, 20_000)

  it('未绑定学生提交命令得到绑定引导，远端零请求、不产生 run', async () => {
    const h = await harness()
    const response = await h.send('/course-search 梯度', 'd'.repeat(32))
    expect(response.body.code).toBe(90003)
    expect(response.body.message).toContain('/settings')
    await h.settle()
    expect(h.calls).toEqual([])
    expect(h.model.inputs).toEqual([])
    expect((await h.projection()).messages).toEqual([])
  }, 20_000)

  it('部署未配置时后端明确拒绝，命令原文不交给模型', async () => {
    const h = await harness({ configured: false })
    const response = await h.send('/topic-search 导数', 'e'.repeat(32))
    expect(response.body.code).toBe(90001)
    expect(response.body.message).toContain('尚未配置')
    await h.settle()
    expect(h.model.inputs).toEqual([])
    expect((await h.projection()).messages).toEqual([])
  }, 20_000)

  it('参数缺失/超长在 REST 面拒绝，远端零请求', async () => {
    const h = await harness()
    await h.bind()
    const missing = await h.send('/course-search', 'f'.repeat(32))
    expect(missing.body.code).toBe(90002)
    expect(missing.body.message).toContain('用法：/course-search <关键词>')
    const tooLong = await h.send(`/topic-search ${'长'.repeat(1001)}`, '0f'.repeat(16))
    expect(tooLong.body.code).toBe(90002)
    expect(tooLong.body.message).toContain('1000')
    await h.settle()
    expect(h.calls).toEqual([])
    expect((await h.projection()).messages).toEqual([])
  }, 20_000)

  it('同 clientKey 重放复用首次结果，不重复查询', async () => {
    const h = await harness()
    await h.bind()
    const key = 'ab'.repeat(16)
    expect((await h.send('/course-search 梯度', key)).body.code).toBe(0)
    await h.settle()
    const replay = await h.send('/course-search 梯度', key)
    expect(replay.body.code).toBe(0)
    expect(replay.body.data.replay).toBe(true)
    await h.settle()
    expect(h.calls).toHaveLength(1)
    expect((await h.projection()).messages.filter((m: { role: string }) => m.role === 'user')).toHaveLength(1)
  }, 20_000)

  it('能力未配置/远端失败准确反馈，工具卡落 error 且 run 失败', async () => {
    const h = await harness()
    await h.bind()
    h.fake.failWith(new ChaoxingConfigError('知识点查询能力尚未配置'))
    expect((await h.send('/topic-search 导数', 'cd'.repeat(16))).body.code).toBe(0)
    await h.settle()
    expect(h.events.find(event => event.type === 'tool.end')).toMatchObject({ payload: { name: 'chaoxing_topic_search', state: 'error' } })
    const failed = h.events.find(event => event.type === 'run.failed')
    expect(failed).toMatchObject({ payload: { message: '知识点查询能力尚未配置' } })
    const projection = await h.projection()
    expect(projection.messages.at(-1)!.tools?.[0]).toMatchObject({ name: 'chaoxing_topic_search', state: 'error' })
  }, 20_000)

  it('远端通用异常不泄露凭证，返回可用性提示', async () => {
    const h = await harness()
    await h.bind()
    h.fake.failWith(new Error('network down owner-token'))
    expect((await h.send('/course-search 梯度', 'ef'.repeat(16))).body.code).toBe(0)
    await h.settle()
    const failed = h.events.find(event => event.type === 'run.failed')
    expect((failed!.payload as { message: string }).message).toContain('超星调用不可用')
    expect((failed!.payload as { message: string }).message).not.toContain('owner-token')
    expect(JSON.stringify(await h.projection())).not.toContain('owner-token')
  }, 20_000)
  it('手动查询结果进入后续模型上下文且不重复注入', async () => {
    const h = await harness()
    await h.bind()
    await h.send('/course-search 梯度下降', '11'.repeat(16))
    await h.settle()
    h.fake.setResult({ resources: [{ id: 't1', name: '导数', kind: 'topic', courseId: 'c1', courseName: '数学', text: '变化率的极限。' }], limitations: [] })
    await h.send('/topic-search 导数', '18'.repeat(16))
    await h.settle()
    expect(h.model.inputs).toEqual([])
    await h.send('解释一下刚才第一份课件和知识点', '12'.repeat(16))
    await h.settle()
    expect(h.model.inputs.at(-1)).toContain('学习率控制迭代步长')
    expect(h.model.inputs.at(-1)).toContain('变化率的极限')
    await h.send('再举一个例子', '14'.repeat(16))
    await h.settle()
    expect(h.model.inputs.at(-1)!.split('学习率控制迭代步长')).toHaveLength(2)
  }, 20_000)

  it('失败原因保留在历史结果中', async () => {
    const h = await harness()
    await h.bind()
    h.fake.failWith(new ChaoxingConfigError('知识点查询能力尚未配置'))
    await h.send('/topic-search 导数', '13'.repeat(16))
    await h.settle()
    const historical = (await h.projection()).messages.at(-1)!
    expect(historical.content).toContain('知识点查询能力尚未配置')
    expect(historical.tools?.[0]).toMatchObject({ state: 'error', details: '知识点查询能力尚未配置' })
    const streamed = h.events.filter(e => e.type === 'text.delta').map(e => (e.payload as { delta: string }).delta).join('')
    expect(streamed).toBe(historical.content)
  }, 20_000)

  it('运行开始后切换课程仅影响下一轮，当前查询保持启动快照', async () => {
    const h = await harness()
    await h.bind()
    await h.prisma.session.update({ where: { id: h.sessionId }, data: { learningCourseId: 'c1' } })
    let switched: Promise<unknown> | undefined
    h.onStarted(() => { switched = h.prisma.session.update({ where: { id: h.sessionId }, data: { learningCourseId: 'c2' } }).then(row => row) })
    await h.send('/course-search 梯度下降', '16'.repeat(16))
    await h.settle()
    await switched
    expect(h.calls[0]?.courseId).toBe('c1')
    await h.send('/course-search 梯度下降', '17'.repeat(16))
    await h.settle()
    expect(h.calls[1]?.courseId).toBe('c2')
  }, 20_000)

  it('已经归档的手动查询不进入后续模型上下文', async () => {
    const h = await harness()
    await h.bind()
    await h.send('/course-search 梯度下降', '19'.repeat(16))
    await h.settle()
    await h.prisma.sessionMessage.updateMany({ where: { sessionId: h.sessionId }, data: { archivedAt: new Date() } })
    await h.send('开始一个新话题', '20'.repeat(16))
    await h.settle()
    expect(h.model.inputs.at(-1)).not.toContain('学习率控制迭代步长')
    expect(h.model.inputs.at(-1)).not.toContain('/course-search 梯度下降')
  }, 20_000)

  it('继承属性名称仍按未知斜杠消息处理，不误执行超星命令', async () => {
    const h = await harness()
    await h.send('/constructor hello', '21'.repeat(16))
    await h.settle()
    expect(h.calls).toEqual([])
    expect(h.model.inputs.at(-1)).toContain('/constructor hello')
    expect(h.events.some(event => event.type === 'run.completed')).toBe(true)
  }, 20_000)

})
