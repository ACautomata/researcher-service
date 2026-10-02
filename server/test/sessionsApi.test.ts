// S1 信封级集成（#778 · #747 Testing Decisions）：会话 REST 域全件——创建/列表/改标题/删除、
// 发消息幂等（story 7）、多端门禁（story 13：running 禁输入 50004 / interrupt 50003 / resume
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
import { seedUser, login, bearer } from './helpers'
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

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 10))
  }
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
  let currentScript: ScriptEntry[]
  let policyTools: readonly string[] | undefined
  let slowExec = false // 慢执行开关（running 窗口制造；afterEach 复位——deps.primitives private 不可换，开关内建）

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
      modelFactory: async () => new ScriptedChatModel(currentScript),
    })
    runService = new RunService({
      prisma,
      registry,
      saver: new PrismaCheckpointSaver(prisma),
      gate: new ConcurrencyGate({ globalLimit: 8, loadUserLimit: async () => 4 }),
      hub,
      primitives: fakePrimitives({
        execBehavior: async () => {
          if (slowExec) await new Promise((r) => setTimeout(r, 200))
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
        void runService.execute(cmd).catch(() => {})
      },
      sandboxes: {
        remove: async (id) => {
          removedSandboxes.push(id)
          return 'removed'
        },
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
    slowExec = false
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

  it('同 key 不同 content → 50006（幂等冲突，零写入）', async () => {
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

  // ---- 多端门禁（story 13）----

  it('running 全端禁输入：run 在飞时 POST /messages → 50004；同 key 重发仍幂等 replay（不门禁）', async () => {
    slowExec = true
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
    await waitFor(() => runService.stateOf(sid)?.state === 'completed')
    const rows = await prisma.sessionMessage.count({ where: { sessionId: sid, clientKey: hexKey(0x201) } })
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

  it('POST /:id/abort：running → 200 + run.aborted{by:user} 广播；无在飞 → 50005', async () => {
    slowExec = true
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

  // ---- 自动标题（story 5）----

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
