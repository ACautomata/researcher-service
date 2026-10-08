// S1 信封级集成（#778 · #747 Testing Decisions）：会话 REST 域全件——创建/列表/改标题/删除、
// 发消息幂等（story 7）、多端门禁（story 13：running 禁输入 50005 / interrupt 50003 / resume
// 先到先得 50001 / 广播一致）、abort（story 8 by:user）、50002 防探测、回放零差异（story 3：
// SSE 事件流归约终态 ≡ 投影 GET 行，逐字节）。
//
// 基建全 fake（对齐 runnerRunService.test.ts）：ScriptedChatModel + fakePrimitives + 真
// StreamHub（双 sink 收帧断言多端广播一致——生产扇出路径）+ 临时 SQLite。dispatch = Inline
// fire-and-forget（生产 BullMQ submit 的测试同形面：命令进 execute、错误经 run 域事件表达）。

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import supertest, { type SuperTest, type Test } from 'supertest'
import { AIMessage } from '@langchain/core/messages'
import { createPrismaClient } from '../src/prisma'
import { createApp } from '../src/app'
import type { PrismaClient } from '../src/generated/prisma/client'
import { StreamHub, type StreamSink } from '../src/events/hub'
import { seedUser, login, bearer, waitFor } from './helpers'
import { ScriptedChatModel, fakePrimitives, toolCallAi, type ScriptEntry } from './runnerFakes'
import { RunService } from '../src/runner/runtime/runService'
import { ProviderRegistry } from '../src/runner/providerRegistry'
import { ConcurrencyGate } from '../src/runner/concurrency'
import { PrismaCheckpointSaver } from '../src/runner/persistence/prismaCheckpointSaver'
import { SessionService } from '../src/sessions/service'
import { TurnReducer, type TurnSnapshot } from '../src/sessions/reducer'
import { CODE } from '../src/codes'
import { installAbortRejectionGuard } from '../src/runner/runtime/abortGuard'

const LAB = 'researcher-sandbox-seed'

interface TestSink {
  sink: StreamSink
  frames: string[]
}

function makeSink(): TestSink {
  const frames: string[] = []
  return {
    sink: {
      send: (w) => {
        frames.push(w)
        return true
      },
      close: () => {},
    },
    frames,
  }
}

// 帧字符串 → {type, sessionId?, runId?, payload}（encodeFrame 的逆，S1 断言层用）。
interface DecodedFrame {
  type: string
  sessionId?: string
  runId?: string
  payload: unknown
}

function frameEvents(frames: string[]): DecodedFrame[] {
  return frames
    .filter((f) => f.startsWith('id: '))
    .map((f) => JSON.parse(/^data: (.+)$/m.exec(f)![1]) as DecodedFrame)
}

describe('会话 REST 域（S1，#778）', () => {
  let prisma: PrismaClient
  let request: SuperTest<Test>
  let hub: StreamHub
  let sinkA: TestSink
  let sinkB: TestSink
  let access: string
  let runService: RunService
  let sessions: SessionService
  const removedSandboxes: string[] = []
  const cleanupDirs: string[] = []
  let observedModel: ScriptedChatModel | undefined
  let currentScript: ScriptEntry[]
  let policyTools: readonly string[] | undefined
  let execGate: Promise<void> | undefined
  let releaseHeldExec: (() => void) | undefined

  // 工具执行由断言显式释放，running 窗口不依赖 CI 调度速度。
  function holdExec(): () => void {
    let release!: () => void
    execGate = new Promise<void>((resolve) => { release = resolve })
    releaseHeldExec = release
    return release
  }
  let userLimit = 4 // per-user 配额开关（quota 预检 40043 用例；afterEach 复位）
  let dispatchFail = false // dispatch（submit ack）失败注入——回滚删行用例；afterEach 复位

  const hexKey = (n: number) => n.toString(16).padStart(32, '0')

  beforeAll(async () => {
    installAbortRejectionGuard()
    const dir = mkdtempSync(path.join(tmpdir(), 'sessions-api-'))
    cleanupDirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma, 'sess-user1', 'pw-sess1-secure')
    await prisma.session.create({
      data: { id: 'sess-seed', ownerId: user.id, containerId: LAB, title: '' },
    })
    await prisma.modelProvider.create({
      data: {
        ownerId: user.id,
        providerId: 'prov-1',
        lcProvider: 'openai',
        baseUrl: 'https://llm.example.edu/v1',
        credentialEnvId: 'LLM_API_KEY',
        authHeader: true,
        modelsJson: JSON.stringify([{ id: 'model-x' }]),
      },
    })
    await prisma.providerEndpoint.create({
      data: { scheme: 'https', host: 'llm.example.edu', port: null, createdBy: 'seed' },
    })

    hub = new StreamHub()
    sinkA = makeSink()
    sinkB = makeSink()
    hub.register(user.id, sinkA.sink)
    hub.register(user.id, sinkB.sink)

    const registry = new ProviderRegistry(prisma, {
      llmApiKey: 'test-key',
      modelFactory: async () => { observedModel = new ScriptedChatModel(currentScript); return observedModel },
    })
    runService = new RunService({
      prisma,
      registry,
      saver: new PrismaCheckpointSaver(prisma),
      gate: new ConcurrencyGate({ globalLimit: 8, loadUserLimit: async () => userLimit }),
      hub,
      primitives: fakePrimitives({
        execBehavior: async () => {
          await execGate
          return { exitCode: 0, stdout: 'fake-exec-out', stderr: '' }
        },
      }).primitives,
      resolveWikiContainer: () => 'researcher-wiki-u1',
      interruptPolicyFor: () => (policyTools ? { tools: policyTools } : undefined),
      clock: (() => {
        let t = 0
        return () => (t += 10)
      })(),
    })
    sessions = new SessionService({
      prisma,
      hub,
      runService,
      dispatch: (cmd) => {
        // submit 入队 ack 语义（生产 BullMQ 同形）：立即 resolve = job 已入队，执行体后台跑；
        // dispatchFail 注入 submit 失败（sendMessage 须回滚删行）。
        if (dispatchFail) return Promise.reject(new Error('queue down'))
        void runService.execute(cmd).catch(() => {})
        return Promise.resolve()
      },
      sandboxes: {
        remove: async (id) => {
          removedSandboxes.push(id)
          return 'removed'
        },
        fork: async () => 'source-missing',
      },
    })
    runService.setRecordTurn((p) => sessions.recordTurn(p))

    const app = createApp({ prisma, events: { hub }, sessions: { service: sessions } })
    request = supertest(app) as unknown as SuperTest<Test>

    const res = await login(request, 'sess-user1', 'pw-sess1-secure')
    access = res.access!
  }, 30_000)

  afterAll(async () => {
    await prisma.$disconnect()
  })

  afterEach(async () => {
    currentScript = []
    policyTools = undefined
    releaseHeldExec?.()
    execGate = undefined
    releaseHeldExec = undefined
    userLimit = 4
    dispatchFail = false
    // bump config_meta.version → registry 模型缓存 miss → 下一用例换新 ScriptedChatModel
    //（脚本 cursor 状态不跨用例污染——对齐 runnerRunService.test.ts「每用例独立模型实例」；
    // 复用生产热生效机制而非重建 RunService/SessionService/app）。测试库无 seed 行 → upsert。
    await prisma.configMeta.upsert({
      where: { id: 1 },
      update: { version: { increment: 1 } },
      create: { id: 1, version: 2 },
    })
  })

  // ---- 基础 CRUD ----

  it('POST / 创建：code 0 + session.created{source:new} 广播（双连接逐字节同帧）+ containerId 预言名', async () => {
    const res = await request
      .post('/api/v1/sessions')
      .set(bearer(access))
      .send({ title: '我的会话' })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(CODE.OK)
    const s = res.body.data as { id: string; title: string; createdAt: string; updatedAt: string }
    expect(s.title).toBe('我的会话')
    const row = await prisma.session.findUnique({ where: { id: s.id } })
    expect(row?.containerId).toBe(`researcher-sandbox-${s.id}`)

    const evs = frameEvents(sinkA.frames).filter((e) => e.type === 'session.created')
    const last = evs[evs.length - 1]
    expect(last).toMatchObject({ sessionId: s.id, payload: { source: 'new', session: { id: s.id } } })
    // 多端广播一致（story 13）：两连接收到的该事件帧逐字节相同（seq 同源 fanOut）
    const frameA = [...sinkA.frames].reverse().find((f) => f.includes('session.created'))
    const frameB = [...sinkB.frames].reverse().find((f) => f.includes('session.created'))
    expect(frameA).toBe(frameB)
  })

  it('GET / 列表：本人会话扁平挂用户（updatedAt DESC），他人会话不可见', async () => {
    const other = await seedUser(prisma, 'sess-user2', 'pw-sess2-secure')
    await prisma.session.create({
      data: { id: 'sess-other-list', ownerId: other.id, containerId: LAB, title: '别人的' },
    })
    const res = await request.get('/api/v1/sessions').set(bearer(access))
    expect(res.body.code).toBe(CODE.OK)
    const ids = (res.body.data.sessions as { id: string }[]).map((x) => x.id)
    expect(ids).not.toContain('sess-other-list')
    expect(ids).toContain('sess-seed')
  })

  it('PATCH /:id 改标题：session.updated 广播；他人/不存在 → 50002 同码', async () => {
    const res = await request
      .patch('/api/v1/sessions/sess-seed')
      .set(bearer(access))
      .send({ title: '新标题' })
    expect(res.body.code).toBe(CODE.OK)
    expect(res.body.data.title).toBe('新标题')
    const updated = frameEvents(sinkA.frames).filter((e) => e.type === 'session.updated')
    expect(updated[updated.length - 1]).toMatchObject({
      sessionId: 'sess-seed',
      payload: { session: { title: '新标题' } },
    })

    const other = await seedUser(prisma, 'sess-user3', 'pw-sess3-secure')
    await prisma.session.create({
      data: { id: 'sess-other-patch', ownerId: other.id, containerId: LAB, title: '' },
    })
    const denied = await request
      .patch('/api/v1/sessions/sess-other-patch')
      .set(bearer(access))
      .send({ title: '越权改' })
    const missing = await request
      .patch('/api/v1/sessions/no-such-session')
      .set(bearer(access))
      .send({ title: '不存在' })
    expect(denied.body.code).toBe(CODE.SESSION_NOT_FOUND)
    expect(missing.body.code).toBe(CODE.SESSION_NOT_FOUND)
    // 防探测：不存在 vs 越权对外逐字节一致
    expect(JSON.stringify(denied.body)).toBe(JSON.stringify(missing.body))
  })

  it('DELETE /:id：级联删沙箱 + DB 行清；消息/checkpoint 行随之消失', async () => {
    const created = await request.post('/api/v1/sessions').set(bearer(access)).send({})
    const id = (created.body.data as { id: string }).id
    await prisma.sessionMessage.create({
      data: { sessionId: id, turn: 1, role: 'user', content: '待级联' },
    })
    const res = await request.delete(`/api/v1/sessions/${id}`).set(bearer(access))
    expect(res.body.code).toBe(CODE.OK)
    expect(removedSandboxes).toContain(id)
    expect(await prisma.session.findUnique({ where: { id } })).toBeNull()
    expect(await prisma.sessionMessage.findFirst({ where: { sessionId: id } })).toBeNull()
    const after = await request.get(`/api/v1/sessions/${id}/messages`).set(bearer(access))
    expect(after.body.code).toBe(CODE.SESSION_NOT_FOUND)
  })

  it('DELETE /:id 在飞互斥：running → 50005 挡删（沙箱保留）；终态后可删', async () => {
    const releaseExec = holdExec()
    currentScript = [toolCallAi('g5', 'execute', { command: 'slow' }), new AIMessage({ content: 'done' })]
    const sid = (await request.post('/api/v1/sessions').set(bearer(access)).send({})).body.data.id as string
    await request
      .post(`/api/v1/sessions/${sid}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x111))
      .send({ content: '删除窗口' })
    await waitFor(() => runService.stateOf(sid)?.state === 'running')

    const blocked = await request.delete(`/api/v1/sessions/${sid}`).set(bearer(access))
    expect(blocked.body.code).toBe(CODE.RUN_IN_PROGRESS)
    expect(removedSandboxes).not.toContain(sid)
    expect(await prisma.session.findUnique({ where: { id: sid } })).not.toBeNull()

    await request.post(`/api/v1/sessions/${sid}/abort`).set(bearer(access))
    releaseExec()
    await waitFor(() => runService.stateOf(sid)?.state === 'aborted')
    const res = await request.delete(`/api/v1/sessions/${sid}`).set(bearer(access))
    expect(res.body.code).toBe(CODE.OK)
    expect(removedSandboxes).toContain(sid)
  }, 15_000)

  // ---- 发消息 + 幂等（story 7）----

  it('POST /:id/messages 正常：落 user 行 + dispatch run → run 域事件 + assistant 行', async () => {
    currentScript = [new AIMessage({ content: '回复文本' })]
    const res = await request
      .post('/api/v1/sessions/sess-seed/messages')
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x101))
      .send({ content: '你好' })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(CODE.OK)
    const data = res.body.data as { messageId: string; turn: number; runId: string; replay: boolean }
    expect(data.replay).toBe(false)
    expect(data.runId).toBeTruthy()
    const userRow = await prisma.sessionMessage.findUnique({ where: { id: data.messageId } })
    expect(userRow).toMatchObject({ sessionId: 'sess-seed', role: 'user', content: '你好', clientKey: hexKey(0x101) })

    await waitFor(() => frameEvents(sinkA.frames).some((e) => e.type === 'run.completed' && e.sessionId === 'sess-seed'))
    const assistantRow = await prisma.sessionMessage.findFirst({
      where: { sessionId: 'sess-seed', role: 'assistant' },
      orderBy: { turn: 'desc' },
    })
    expect(assistantRow?.content).toBe('回复文本')
  })

  it('幂等重发：同 key 同 content → replay:true 零新行零新 run（断网重发不重复入列）', async () => {
    currentScript = [new AIMessage({ content: '首跑' })]
    const beforeAssistantCount = await prisma.sessionMessage.count({
      where: { sessionId: 'sess-seed', role: 'assistant' },
    })
    const first = await request
      .post('/api/v1/sessions/sess-seed/messages')
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x102))
      .send({ content: '只发一次' })
    expect(first.body.data.replay).toBe(false)

    const replay = await request
      .post('/api/v1/sessions/sess-seed/messages')
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x102))
      .send({ content: '只发一次' })
    expect(replay.body.code).toBe(CODE.OK)
    expect(replay.body.data).toMatchObject({
      messageId: first.body.data.messageId,
      replay: true,
      runId: null,
    })
    const rows = await prisma.sessionMessage.count({ where: { sessionId: 'sess-seed', clientKey: hexKey(0x102) } })
    expect(rows).toBe(1)
    // 等首轮 run 完成后确认重发没有触发第二个 run（assistant 行恰增 1——仅首轮）
    await waitFor(() => ['completed', 'failed'].includes(runService.stateOf('sess-seed')?.state ?? ''))
    const finalAssistantCount = await prisma.sessionMessage.count({
      where: { sessionId: 'sess-seed', role: 'assistant' },
    })
    expect(finalAssistantCount).toBe(beforeAssistantCount + 1) // 仅首轮的 assistant 行
  })

  it('并发同 key：双请求并发提交 → 同 key 单落（P2002 兜底重查），败方 replay 形态', async () => {
    currentScript = [new AIMessage({ content: '并发回复' })]
    const key = hexKey(0x103)
    const [r1, r2] = await Promise.all([
      request.post('/api/v1/sessions/sess-seed/messages').set(bearer(access)).set('Idempotency-Key', key).send({ content: '并发消息' }),
      request.post('/api/v1/sessions/sess-seed/messages').set(bearer(access)).set('Idempotency-Key', key).send({ content: '并发消息' }),
    ])
    expect(r1.body.code).toBe(CODE.OK)
    expect(r2.body.code).toBe(CODE.OK)
    const rows = await prisma.sessionMessage.findMany({ where: { sessionId: 'sess-seed', clientKey: key } })
    expect(rows).toHaveLength(1)
    const replays = [r1, r2].filter((r) => r.body.data.replay === true)
    expect(replays).toHaveLength(1)
    expect(replays[0]!.body.data.messageId).toBe(
      [r1, r2].find((r) => r.body.data.replay === false)!.body.data.messageId,
    )
    await waitFor(() => ['completed', 'failed'].includes(runService.stateOf('sess-seed')?.state ?? ''))
  })

  it('同 key 不同 content → 50007（幂等冲突，零写入）', async () => {
    const key = hexKey(0x104)
    await request
      .post('/api/v1/sessions/sess-seed/messages')
      .set(bearer(access))
      .set('Idempotency-Key', key)
      .send({ content: '原始内容' })
    await waitFor(() => ['completed', 'failed'].includes(runService.stateOf('sess-seed')?.state ?? ''))
    const conflict = await request
      .post('/api/v1/sessions/sess-seed/messages')
      .set(bearer(access))
      .set('Idempotency-Key', key)
      .send({ content: '不同内容' })
    expect(conflict.body.code).toBe(CODE.MESSAGE_KEY_CONFLICT)
    const rows = await prisma.sessionMessage.count({ where: { sessionId: 'sess-seed', clientKey: key } })
    expect(rows).toBe(1)
  })

  it('缺/坏 Idempotency-Key → 90002（data null，不被 body 校验掩盖）；body 非法 → 90002 字段明细', async () => {
    const noKey = await request
      .post('/api/v1/sessions/sess-seed/messages')
      .set(bearer(access))
      .send({ content: 'x' })
    expect(noKey.body.code).toBe(CODE.VALIDATION_FAILED)
    expect(noKey.body.data).toBeNull()

    const badKey = await request
      .post('/api/v1/sessions/sess-seed/messages')
      .set(bearer(access))
      .set('Idempotency-Key', 'NOT-HEX')
      .send({ content: 'x' })
    expect(badKey.body.code).toBe(CODE.VALIDATION_FAILED)

    const badBody = await request
      .post('/api/v1/sessions/sess-seed/messages')
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x105))
      .send({ content: '' })
    expect(badBody.body.code).toBe(CODE.VALIDATION_FAILED)
    expect(badBody.body.data).toMatchObject({ content: expect.any(Array) })
  })

  it('official /research template reaches the runner as a user message; skill body is progressively disclosed', async () => {
    currentScript = [toolCallAi('read-skill', 'read_official_skill', { name: 'research' }), new AIMessage('research done')]
    const sid = (await request.post('/api/v1/sessions').set(bearer(access)).send({})).body.data.id as string
    const sent = await request.post(`/api/v1/sessions/${sid}/messages`).set(bearer(access)).set('Idempotency-Key', hexKey(0x787)).send({ content: '/research 电池寿命' })
    expect(sent.body.code).toBe(CODE.OK)
    await waitFor(() => frameEvents(sinkA.frames).some(e => e.sessionId === sid && e.type === 'run.completed'))
    const inputs = observedModel!.receivedMessages as { content: string; getType(): string }[][]
    expect(inputs[0]!.find(m => m.getType() === 'human')!.content).toContain('电池寿命')
    expect(inputs[0]!.find(m => m.getType() === 'human')!.content).toContain('先读取技能正文')
    expect(inputs[0]!.find(m => m.getType() === 'system')!.content).not.toContain('完成标准：核心问题')
    expect(inputs[1]!.find(m => m.getType() === 'tool')!.content).toContain('完成标准：核心问题')
    const projection = await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))
    // 落行存原始输入（/命令原文）——展开只发生在命令构造点，模板发版改文不破幂等 replay
    expect(projection.body.data.messages[0].content).toContain('/research 电池寿命')
    const replay = await request.post(`/api/v1/sessions/${sid}/messages`).set(bearer(access)).set('Idempotency-Key', hexKey(0x787)).send({ content: '/research 电池寿命' })
    expect(replay.body.data.replay).toBe(true)
  })

  it('/new creates a fresh session once without starting a model run', async () => {
    const sid = (await request.post('/api/v1/sessions').set(bearer(access)).send({})).body.data.id as string
    const send = () => request.post(`/api/v1/sessions/${sid}/messages`).set(bearer(access)).set('Idempotency-Key', hexKey(0x788)).send({ content: '/new' })
    const first = await send()
    expect(first.body.code).toBe(CODE.OK)
    expect(first.body.data.command).toMatchObject({ name: 'new', sessionId: expect.any(String) })
    const again = await send()
    expect(again.body.data.command.sessionId).toBe(first.body.data.command.sessionId)
    expect(again.body.data.replay).toBe(true)
    expect(first.body.data.runId).toBeNull()
    expect((await request.get('/api/v1/sessions').set(bearer(access))).body.data.sessions.some((s: { id: string }) => s.id === first.body.data.command.sessionId)).toBe(true)
  })

  it('/model lists configured models, persists a next-run choice, and rejects unknown values', async () => {
    const sid = (await request.post('/api/v1/sessions').set(bearer(access)).send({})).body.data.id as string
    const send = (content: string, n: number) => request.post(`/api/v1/sessions/${sid}/messages`).set(bearer(access)).set('Idempotency-Key', hexKey(n)).send({ content })
    const listed = await send('/model', 0x789)
    expect(listed.body.code).toBe(CODE.OK)
    expect(listed.body.data.command.models).toContainEqual({ providerId: 'prov-1', modelId: 'model-x' })
    // 列清单是查询不是变更：不广播 session.updated（model:undefined 噪音）
    expect(frameEvents(sinkA.frames).filter(e => e.sessionId === sid && e.type === 'session.updated')).toHaveLength(0)
    const picked = await send('/model prov-1/model-x', 0x790)
    expect(picked.body.code).toBe(CODE.OK)
    expect(picked.body.data.command).toMatchObject({ name: 'model', model: { providerId: 'prov-1', modelId: 'model-x' }, appliesTo: 'next-run' })
    expect((await send('/model prov-1/missing', 0x791)).body.code).toBe(CODE.PROVIDER_NOT_FOUND)
    expect((await send('/model default', 0x792)).body.data.command.model).toBeNull()
    expect(picked.body.data.runId).toBeNull()
    // 偏好落定（含 default 重置）恰广播一次
    expect(frameEvents(sinkA.frames).filter(e => e.sessionId === sid && e.type === 'session.updated')).toHaveLength(2)
  })

  it('/compact compacts the thread: pre-cutoff turns leave the model context, summary persists', async () => {
    const sid = (await request.post('/api/v1/sessions').set(bearer(access)).send({})).body.data.id as string
    const send = (content: string, n: number) => request.post(`/api/v1/sessions/${sid}/messages`).set(bearer(access)).set('Idempotency-Key', hexKey(n)).send({ content })
    // 保留窗 6：4 轮对话 = 8 条消息（>7 才有可压缩余量）；脚本序 = run1..4 → compact 摘要 → run5
    currentScript = [new AIMessage('a1'), new AIMessage('a2'), new AIMessage('a3'), new AIMessage('a4'), new AIMessage('COMPACT-SUMMARY-TEXT'), new AIMessage('a5')]
    for (const n of [1, 2, 3, 4]) {
      expect((await send(`q${n}`, 0x800 + n)).body.code).toBe(CODE.OK)
      await waitFor(() => frameEvents(sinkA.frames).filter(e => e.sessionId === sid && e.type === 'run.completed').length >= n)
    }
    const compact = await send('/compact', 0x900)
    expect(compact.body.code).toBe(CODE.OK)
    expect(compact.body.data.runId).toBeTruthy()
    await waitFor(() => frameEvents(sinkA.frames).filter(e => e.sessionId === sid && e.type === 'run.completed').length >= 5)
    expect((await send('q5', 0x905)).body.code).toBe(CODE.OK)
    await waitFor(() => frameEvents(sinkA.frames).filter(e => e.sessionId === sid && e.type === 'run.completed').length >= 6)
    const inputs = observedModel!.receivedMessages as { content: string; getType(): string }[][]
    // 摘要调用：压缩提示 + 被截转写（q1/a1 在内、保留窗外的 q4 不在）
    const summaryPrompt = inputs[4]!.filter(m => m.getType() === 'human').map(m => String(m.content)).join('')
    expect(summaryPrompt).toContain('会话压缩器')
    expect(summaryPrompt).toContain('[human] q1')
    expect(summaryPrompt).toContain('[ai] a1')
    expect(summaryPrompt).not.toContain('q4')
    // 压缩后 run5 的上下文：摘要在、q1/a1 不在、保留窗尾部（q4/a4/q5）在
    const after = inputs.at(-1)!
    expect(after.some(m => m.getType() === 'human' && String(m.content).includes('COMPACT-SUMMARY-TEXT'))).toBe(true)
    expect(after.some(m => String(m.content).includes('q1'))).toBe(false)
    expect(after.some(m => String(m.content).includes('q4'))).toBe(true)
    expect(after.some(m => String(m.content).includes('q5'))).toBe(true)
  })

  it('/compact on a short thread is a no-op that still completes the run', async () => {
    const sid = (await request.post('/api/v1/sessions').set(bearer(access)).send({})).body.data.id as string
    const send = (content: string, n: number) => request.post(`/api/v1/sessions/${sid}/messages`).set(bearer(access)).set('Idempotency-Key', hexKey(n)).send({ content })
    currentScript = [new AIMessage('solo answer'), new AIMessage('after answer')]
    expect((await send('only question', 0x910)).body.code).toBe(CODE.OK)
    await waitFor(() => frameEvents(sinkA.frames).filter(e => e.sessionId === sid && e.type === 'run.completed').length >= 1)
    const compact = await send('/compact', 0x911)
    expect(compact.body.code).toBe(CODE.OK)
    await waitFor(() => frameEvents(sinkA.frames).filter(e => e.sessionId === sid && e.type === 'run.completed').length >= 2)
    expect((await send('follow-up', 0x912)).body.code).toBe(CODE.OK)
    await waitFor(() => frameEvents(sinkA.frames).filter(e => e.sessionId === sid && e.type === 'run.completed').length >= 3)
    const inputs = observedModel!.receivedMessages as unknown[][]
    // no-op：摘要调用未发生（仅 run1/run3 两次 invoke），上下文原样保留
    expect(inputs.length).toBe(2)
    expect(inputs.at(-1)!.some(m => String((m as { content: unknown }).content).includes('only question'))).toBe(true)
  })

  // ---- 多端门禁（story 13）----

  it('running 全端禁输入：run 在飞时 POST /messages → 50005；同 key 重发仍幂等 replay（不门禁）', async () => {
    const releaseExec = holdExec()
    currentScript = [toolCallAi('g1', 'execute', { command: 'slow' }), new AIMessage({ content: 'done' })]
    const sid = (await request.post('/api/v1/sessions').set(bearer(access)).send({})).body.data.id as string
    const first = await request
      .post(`/api/v1/sessions/${sid}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x201))
      .send({ content: '触发慢 run' })
    await waitFor(() => runService.stateOf(sid)?.state === 'running')
    const rejected = await request
      .post(`/api/v1/sessions/${sid}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x202))
      .send({ content: 'run 中插话' })
    expect(rejected.body.code).toBe(CODE.RUN_IN_PROGRESS)
    // 断网重发面：同 key 命中既有行 → replay 应答（先于门禁），不产生重复行
    const replay = await request
      .post(`/api/v1/sessions/${sid}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x201))
      .send({ content: '触发慢 run' })
    expect(replay.body.code).toBe(CODE.OK)
    expect(replay.body.data).toMatchObject({ messageId: first.body.data.messageId, replay: true })
    releaseExec()
    await waitFor(() => runService.stateOf(sid)?.state === 'completed')
    const rows = await prisma.sessionMessage.count({ where: { sessionId: sid, clientKey: hexKey(0x201) } })
    expect(rows).toBe(1)
  })

  it('配额满即时反馈：per-user 额度耗尽 → POST /messages 40043（REST 预检，不落行不入队）', async () => {
    userLimit = 0
    currentScript = [new AIMessage({ content: '不应到达' })]
    const before = frameEvents(sinkA.frames).length
    const res = await request
      .post('/api/v1/sessions/sess-seed/messages')
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x203))
      .send({ content: '配额外消息' })
    expect(res.body.code).toBe(CODE.CONCURRENCY_QUOTA_EXCEEDED)
    expect(await prisma.sessionMessage.count({ where: { sessionId: 'sess-seed', clientKey: hexKey(0x203) } })).toBe(0)
    // 无 run 域事件（预检在 dispatch 前）
    expect(frameEvents(sinkA.frames.slice(before))).toHaveLength(0)
  })

  it('配额满 resume 同挡：interrupted 会话 resume → 40043；恢复配额后重试成功（不停 interrupted 静默）', async () => {
    policyTools = ['execute']
    currentScript = [toolCallAi('g6', 'execute', { command: 'x' }), new AIMessage({ content: '续跑完成。' })]
    const sid = (await request.post('/api/v1/sessions').set(bearer(access)).send({})).body.data.id as string
    await request
      .post(`/api/v1/sessions/${sid}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x206))
      .send({ content: '触发 interrupt' })
    await waitFor(() => runService.stateOf(sid)?.state === 'interrupted')

    userLimit = 0
    const blocked = await request.post(`/api/v1/sessions/${sid}/resume`).set(bearer(access)).send({})
    expect(blocked.body.code).toBe(CODE.CONCURRENCY_QUOTA_EXCEEDED)

    // state 未变（仍 interrupted），恢复配额后同一入口重试成功
    userLimit = 4
    const retried = await request
      .post(`/api/v1/sessions/${sid}/resume`)
      .set(bearer(access))
      .send({ decisions: { decisions: [{ type: 'approve' }] } })
    expect(retried.body.code).toBe(CODE.OK)
    await waitFor(() => runService.stateOf(sid)?.state === 'completed')
  }, 15_000)

  it('dispatch ack 失败回滚：submit 拒绝 → 90000 + user 行回滚，幂等键不锁死（修复后重发正常入队）', async () => {
    currentScript = [new AIMessage({ content: '入队后回复' })]
    dispatchFail = true
    const failed = await request
      .post('/api/v1/sessions/sess-seed/messages')
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x205))
      .send({ content: '会回滚的消息' })
    expect(failed.body.code).toBe(CODE.INTERNAL)
    expect(await prisma.sessionMessage.count({ where: { sessionId: 'sess-seed', clientKey: hexKey(0x205) } })).toBe(0)

    // 幂等键未被锁死：修复后同 key 重发重走全流程（新行 + 正常入队 + replay:false）
    dispatchFail = false
    const retry = await request
      .post('/api/v1/sessions/sess-seed/messages')
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x205))
      .send({ content: '会回滚的消息' })
    expect(retry.body.code).toBe(CODE.OK)
    expect(retry.body.data).toMatchObject({ replay: false })
    await waitFor(() =>
      frameEvents(sinkA.frames).some((e) => e.type === 'run.completed' && e.sessionId === 'sess-seed'),
    )
    const rows = await prisma.sessionMessage.count({ where: { sessionId: 'sess-seed', clientKey: hexKey(0x205) } })
    expect(rows).toBe(1)
  })

  it('interrupt 全端可审批面：interrupted 态 POST /messages → 50003；resume → 200；resume 后再 resume → 50001', async () => {
    const sid = (await request.post('/api/v1/sessions').set(bearer(access)).send({})).body.data.id as string
    policyTools = ['execute']
    currentScript = [toolCallAi('g2', 'execute', { command: 'x' }), new AIMessage({ content: '续跑完成。' })]
    await request
      .post(`/api/v1/sessions/${sid}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x301))
      .send({ content: '触发 interrupt' })
    await waitFor(() => runService.stateOf(sid)?.state === 'interrupted')

    const pending = await request
      .post(`/api/v1/sessions/${sid}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x302))
      .send({ content: 'interrupt 中插话' })
    expect(pending.body.code).toBe(CODE.RUN_INTERRUPT_PENDING)

    const resumed = await request
      .post(`/api/v1/sessions/${sid}/resume`)
      .set(bearer(access))
      .send({ decisions: { decisions: [{ type: 'approve' }] } })
    expect(resumed.body.code).toBe(CODE.OK)
    expect(resumed.body.data.runId).toBeTruthy()
    await waitFor(() => runService.stateOf(sid)?.state === 'completed')

    const loser = await request.post(`/api/v1/sessions/${sid}/resume`).set(bearer(access)).send({})
    expect(loser.body.code).toBe(CODE.RUN_ALREADY_RESUMED)
  }, 15_000)

  // ---- abort（story 8）----

  it('POST /:id/abort：running → 200 + run.aborted{by:user} 广播；无在飞 → 50006', async () => {
    const releaseExec = holdExec()
    currentScript = [toolCallAi('g3', 'execute', { command: 'slow' }), new AIMessage({ content: 'done' })]
    const sid = (await request.post('/api/v1/sessions').set(bearer(access)).send({})).body.data.id as string
    await request
      .post(`/api/v1/sessions/${sid}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x401))
      .send({ content: '将被中断' })
    await waitFor(() => runService.stateOf(sid)?.state === 'running')

    const abort = await request.post(`/api/v1/sessions/${sid}/abort`).set(bearer(access))
    expect(abort.body.code).toBe(CODE.OK)
    expect(abort.body.data.runId).toBeTruthy()
    releaseExec()
    await waitFor(() => runService.stateOf(sid)?.state === 'aborted')
    const evs = frameEvents(sinkA.frames).filter((e) => e.type === 'run.aborted' && e.sessionId === sid)
    expect(evs[evs.length - 1]!.payload).toMatchObject({ by: 'user' })

    const again = await request.post(`/api/v1/sessions/${sid}/abort`).set(bearer(access))
    expect(again.body.code).toBe(CODE.RUN_NOT_ABORTABLE)
  }, 15_000)

  // ---- 50002 防探测（messages 面同码）----

  it('messages/abort/resume 的 50002：不存在 vs 越权对外逐字节一致', async () => {
    const other = await seedUser(prisma, 'sess-user4', 'pw-sess4-secure')
    await prisma.session.create({
      data: { id: 'sess-other-msg', ownerId: other.id, containerId: LAB, title: '' },
    })
    const bodies: unknown[] = []
    for (const sid of ['sess-other-msg', 'no-such-session']) {
      const m = await request
        .post(`/api/v1/sessions/${sid}/messages`)
        .set(bearer(access))
        .set('Idempotency-Key', hexKey(0x500 + sid.length))
        .send({ content: 'x' })
      const a = await request.post(`/api/v1/sessions/${sid}/abort`).set(bearer(access))
      const r = await request.post(`/api/v1/sessions/${sid}/resume`).set(bearer(access)).send({})
      const g = await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))
      expect(m.body.code).toBe(CODE.SESSION_NOT_FOUND)
      expect(a.body.code).toBe(CODE.SESSION_NOT_FOUND)
      expect(r.body.code).toBe(CODE.SESSION_NOT_FOUND)
      expect(g.body.code).toBe(CODE.SESSION_NOT_FOUND)
      bodies.push(JSON.stringify([m.body, a.body, r.body, g.body]))
    }
    expect(bodies[0]).toBe(bodies[1])
  })

  // ---- 回放零差异（story 3）----

  it('投影 GET 与事件流归约终态逐字节一致（text+thinking+tool 全面）；user 行在前', async () => {
    currentScript = [
      new AIMessage({
        content: [
          { type: 'thinking', thinking: '先想想用户要什么。' },
          { type: 'text', text: '我来列目录。' },
        ],
        tool_calls: [{ id: 'z1', name: 'execute', args: { command: 'ls' } }],
      }),
      new AIMessage({ content: '目录已列出，共 3 项。' }),
    ]
    const sid = (await request.post('/api/v1/sessions').set(bearer(access)).send({})).body.data.id as string
    const before = frameEvents(sinkA.frames).length
    await request
      .post(`/api/v1/sessions/${sid}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x601))
      .send({ content: '帮我看看 lab 里有什么' })
    await waitFor(() =>
      frameEvents(sinkA.frames.slice(before)).some((e) => e.type === 'run.completed' && e.sessionId === sid),
    )

    // 事件流归约（前端 #730 同款逻辑的参考实现）——只消费本会话的 run 域事件
    const reducer = new TurnReducer()
    for (const ev of frameEvents(sinkA.frames)) {
      if (ev.sessionId !== sid) continue
      if (['text.delta', 'thinking.delta', 'tool.start', 'tool.end'].includes(ev.type)) {
        reducer.feed(ev)
      }
    }
    const snapshot: TurnSnapshot = reducer.snapshot()

    const projection = await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))
    expect(projection.body.code).toBe(CODE.OK)
    const messages = projection.body.data.messages as {
      id: string
      turn: number
      role: string
      content: string
      thinking?: string
      tools?: unknown[]
      anchorCheckpointId: string | null
      createdAt: string
    }[]
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user', content: '帮我看看 lab 里有什么', turn: 1 })
    const assistant = messages[1]!
    expect(assistant.role).toBe('assistant')

    // 逐字节一致：投影行（content 列 + attachmentsJson 聚合面）≡ 事件流归约快照
    const fromRow = JSON.stringify({
      content: assistant.content,
      ...(assistant.thinking !== undefined ? { thinking: assistant.thinking } : {}),
      ...(assistant.tools !== undefined ? { tools: assistant.tools } : {}),
    })
    expect(fromRow).toBe(JSON.stringify(snapshot))
    // anchorCheckpointId = run 终态 checkpoint 锚点（issue 点名列；completed 路径从
    // StateSnapshot.config.configurable.checkpoint_id 取，真 LangGraph 跑完必有值）
    expect(assistant.anchorCheckpointId).toEqual(expect.any(String))
  })

  it('interrupted 两段式回放零差异：interrupt 轮部分聚合行 ≡ 事件归约；resume 轮新行 ≡ 续跑归约', async () => {
    policyTools = ['execute']
    currentScript = [
      toolCallAi('g4', 'execute', { command: 'ls' }, '先执行列目录。'),
      new AIMessage({ content: '审批后续跑的第二段输出。' }),
    ]
    const sid = (await request.post('/api/v1/sessions').set(bearer(access)).send({})).body.data.id as string
    const before = frameEvents(sinkA.frames).length
    await request
      .post(`/api/v1/sessions/${sid}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x501))
      .send({ content: '两段式回放' })
    await waitFor(() => runService.stateOf(sid)?.state === 'interrupted')

    // 第一段：interrupted 也落部分聚合行（「刷新回放须含已流出部分」）——与本轮事件归约逐字节一致
    const p1 = await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))
    expect(p1.body.code).toBe(CODE.OK)
    const messages1 = p1.body.data.messages as {
      id: string
      turn: number
      role: string
      content: string
      thinking?: string
      tools?: unknown[]
    }[]
    expect(messages1).toHaveLength(2)
    expect(messages1[0]).toMatchObject({ role: 'user', content: '两段式回放', turn: 1 })
    const assistant1 = messages1[1]!
    expect(assistant1.role).toBe('assistant')
    const reducer1 = new TurnReducer()
    for (const ev of frameEvents(sinkA.frames.slice(before))) {
      if (ev.sessionId !== sid) continue
      if (['text.delta', 'thinking.delta', 'tool.start', 'tool.end'].includes(ev.type)) reducer1.feed(ev)
    }
    expect(
      JSON.stringify({
        content: assistant1.content,
        ...(assistant1.thinking !== undefined ? { thinking: assistant1.thinking } : {}),
        ...(assistant1.tools !== undefined ? { tools: assistant1.tools } : {}),
      }),
    ).toBe(JSON.stringify(reducer1.snapshot()))
    const rowsAfterTurn1 = messages1.length
    const framesAfterTurn1 = sinkA.frames.length

    // 第二段：resume → 新 assistant 行（turn 递增），仅由续跑轮事件归约得出——两段式零差异
    const resumed = await request
      .post(`/api/v1/sessions/${sid}/resume`)
      .set(bearer(access))
      .send({ decisions: { decisions: [{ type: 'approve' }] } })
    expect(resumed.body.code).toBe(CODE.OK)
    await waitFor(() => runService.stateOf(sid)?.state === 'completed')

    const p2 = await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))
    expect(p2.body.code).toBe(CODE.OK)
    const messages2 = p2.body.data.messages as {
      id: string
      turn: number
      role: string
      content: string
      thinking?: string
      tools?: unknown[]
    }[]
    expect(messages2).toHaveLength(3)
    expect(messages2[1]).toMatchObject({ role: 'assistant', turn: 2 })
    const assistant2 = messages2[2]!
    expect(assistant2).toMatchObject({ role: 'assistant', turn: 3, content: '审批后续跑的第二段输出。' })
    const reducer2 = new TurnReducer()
    for (const ev of frameEvents(sinkA.frames.slice(framesAfterTurn1))) {
      if (ev.sessionId !== sid) continue
      if (['text.delta', 'thinking.delta', 'tool.start', 'tool.end'].includes(ev.type)) reducer2.feed(ev)
    }
    expect(
      JSON.stringify({
        content: assistant2.content,
        ...(assistant2.thinking !== undefined ? { thinking: assistant2.thinking } : {}),
        ...(assistant2.tools !== undefined ? { tools: assistant2.tools } : {}),
      }),
    ).toBe(JSON.stringify(reducer2.snapshot()))
    expect(rowsAfterTurn1).toBe(2)
  }, 15_000)

  // ---- 自动标题（story 5 · 语义翻案：主触发 = 首条消息被接受（dispatch ack），与 run 终态解耦）----

  it('run 失败（空聚合）也生成标题：POST 200 后立即查 DB title 非空（不 waitFor 终态——锁定与终态解耦）', async () => {
    // ScriptEntry 耗尽：首次 invoke 即抛 'script exhausted' → run.failed 空聚合（recordTurn 不触发）。
    currentScript = []
    const sid = (await request.post('/api/v1/sessions').set(bearer(access)).send({})).body.data.id as string
    await request
      .post(`/api/v1/sessions/${sid}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x705))
      .send({ content: '失败会话的标题来自首条消息' })
    // 不 waitFor run 终态——主触发在 dispatch ack 时已落库（REST 面，与 run 生命周期解耦）。
    const row = await prisma.session.findUnique({ where: { id: sid } })
    expect(row?.title).toBe('失败会话的标题来自首条消息'.slice(0, 30))
    // session.updated{session.title} 广播已出（title 非空即 autoTitle 成功）。
    const updated = frameEvents(sinkA.frames).filter((e) => e.type === 'session.updated' && e.sessionId === sid)
    expect(updated.length).toBeGreaterThan(0)
  })

  it('dispatch 失败回滚不留幽灵标题：POST 信封 90000 → DB title 仍空', async () => {
    // 新空标题会话（避免与 sess-seed 既有用例的幂等键/状态冲突）。
    const sid = (await request.post('/api/v1/sessions').set(bearer(access)).send({})).body.data.id as string
    dispatchFail = true
    try {
      const res = await request
        .post(`/api/v1/sessions/${sid}/messages`)
        .set(bearer(access))
        .set('Idempotency-Key', hexKey(0x706))
        .send({ content: '这条消息入队失败应回滚' })
      expect(res.status).toBe(200) // #312 信封：HTTP 恒 200，code=90000
      expect(res.body.code).toBe(90000)
      // 消息行已随 dispatch 失败回滚删——autoTitle 不该被触发（否则留下无消息的幽灵标题）。
      const row = await prisma.session.findUnique({ where: { id: sid } })
      expect(row?.title).toBe('')
    } finally {
      dispatchFail = false
    }
  })

  it('run 终态自动生成标题（首条 user 消息截断）+ session.updated 广播；已有标题不覆盖', async () => {
    currentScript = [new AIMessage({ content: '好' })]
    const sid = (await request.post('/api/v1/sessions').set(bearer(access)).send({})).body.data.id as string
    await request
      .post(`/api/v1/sessions/${sid}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x701))
      .send({ content: '这是一条会被截断成标题的长消息内容' })
    await waitFor(() => runService.stateOf(sid)?.state === 'completed')
    await waitFor(async () => {
      const row = await prisma.session.findUnique({ where: { id: sid } })
      return row !== null && row.title !== ''
    })
    const row = await prisma.session.findUnique({ where: { id: sid } })
    expect(row?.title).toBe('这是一条会被截断成标题的长消息内容'.slice(0, 30))
    const updated = frameEvents(sinkA.frames).filter((e) => e.type === 'session.updated' && e.sessionId === sid)
    expect(updated.length).toBeGreaterThan(0)

    // 已有标题的会话：再跑 run 不覆盖
    currentScript = [new AIMessage({ content: '再跑' })]
    await request
      .post(`/api/v1/sessions/sess-seed/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x702))
      .send({ content: 'sess-seed 已有标题' })
    await waitFor(() => ['completed', 'failed'].includes(runService.stateOf('sess-seed')?.state ?? ''))
    expect((await prisma.session.findUnique({ where: { id: 'sess-seed' } }))?.title).toBe('新标题')
  })

  // ---- inFlight 投影（story 11 · #779 断线补偿）----

  it('投影 GET 的 inFlight：running 带 checkpoint 重建 turn（多端同形）；终态字段缺省', async () => {
    const releaseExec = holdExec()
    currentScript = [
      toolCallAi('if-c1', 'execute', { command: 'echo hi' }, '想想。'),
      new AIMessage({ content: [{ type: 'text', text: '完成。' }] }),
    ]
    const sid = (await request.post('/api/v1/sessions').set(bearer(access)).send({})).body.data.id as string
    await request
      .post(`/api/v1/sessions/${sid}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey(0x801))
      .send({ content: '慢问题' })
    await waitFor(() => runService.stateOf(sid)?.state === 'running')

    // 等工具行进 checkpoint（慢工具窗口 = 重建素材窗口）
    let inFlight: { runId: string; state: string; turn: { tools?: { toolCallId: string; name: string }[] } } | undefined
    await waitFor(async () => {
      const res = await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))
      inFlight = res.body.data.inFlight as typeof inFlight
      return (inFlight?.turn.tools?.length ?? 0) > 0
    })
    expect(inFlight?.state).toBe('running')
    expect(inFlight?.turn.tools?.[0]).toMatchObject({ toolCallId: 'if-c1', name: 'execute' })

    // 多端/换设备重拉同形：同一内存态 + 同一 checkpoint → runId/turn 一致
    const res2 = await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))
    const inFlight2 = res2.body.data.inFlight as typeof inFlight
    expect(inFlight2?.runId).toBe(inFlight?.runId)
    expect(inFlight2?.state).toBe('running')
    expect(inFlight2?.turn.tools?.[0]).toMatchObject({ toolCallId: 'if-c1' })

    // 终态 → 字段缺省（「无进行中 run」的投影形状）
    releaseExec()
    await waitFor(() => runService.stateOf(sid)?.state === 'completed')
    const final = await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))
    expect(final.body.data.inFlight).toBeUndefined()
  })

  // ---- 认证边界 ----

  it('无 token → 10001（全端点）', async () => {
    const r1 = await request.get('/api/v1/sessions')
    const r2 = await request.post('/api/v1/sessions').send({})
    const r3 = await request.get('/api/v1/sessions/sess-seed/messages')
    expect(r1.body.code).toBe(CODE.UNAUTHENTICATED)
    expect(r2.body.code).toBe(CODE.UNAUTHENTICATED)
    expect(r3.body.code).toBe(CODE.UNAUTHENTICATED)
  })
})
