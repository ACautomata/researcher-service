// S1 信封级集成（#781 · #747 story 16/18/20 + #770 软删 + #768 D7）：rewind 换锚（指针 +
// 软删存档 + 投影过滤 + session.invalidated 帧）、rewind 后 time-travel 分叉续跑（checkpoint
// parent 断言）、fork 全件（溯源行 + checkpoint/消息/journal/attachments 截断复制 + 沙箱字面
// 复制 fake 面 + 系统消息 + session.created{source:fork} 帧）。
//
// 基建全 fake（对齐 sessionsApi.test.ts）：ScriptedChatModel + fakePrimitives + 真
// StreamHub（sink 收帧）+ 真 PrismaCheckpointSaver（checkpoint 链落真表）+ 临时 SQLite。

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
import { CODE } from '../src/codes'
import { installAbortRejectionGuard } from '../src/runner/runtime/abortGuard'

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

interface DecodedFrame {
  type: string
  sessionId?: string
  payload: unknown
}

function frameEvents(frames: string[]): DecodedFrame[] {
  return frames
    .filter((f) => f.startsWith('id: '))
    .map((f) => JSON.parse(/^data: (.+)$/m.exec(f)![1]) as DecodedFrame)
}

interface ProjectionMsg {
  id: string
  turn: number
  role: string
  content: string
  anchorCheckpointId: string | null
}

describe('rewind / fork 会话历史域（S1，#781）', () => {
  let prisma: PrismaClient
  let request: SuperTest<Test>
  let hub: StreamHub
  let sink: TestSink
  let access: string
  let runService: RunService
  let sessions: SessionService
  const cleanupDirs: string[] = []
  let currentScript: ScriptEntry[] = []
  let slowExec = false
  let forkOutcome: 'copied' | 'source-missing' = 'copied'
  let forkCalls: [string, string][] = []
  let forkThrows = false
  let removeCalls: string[] = []
  let keySeq = 0x300
  const hexKey = () => (keySeq++).toString(16).padStart(32, '0')

  // 建会话 + 跑 N 轮对话（每轮 POST message → 等 completed），返回会话 id。
  async function seedConversation(title: string, turns: string[]): Promise<string> {
    const created = await request.post('/api/v1/sessions').set(bearer(access)).send({ title })
    const sid = created.body.data.id as string
    for (const turn of turns) {
      currentScript.push(new AIMessage({ content: `回复:${turn}` }))
      const res = await request
        .post(`/api/v1/sessions/${sid}/messages`)
        .set(bearer(access))
        .set('Idempotency-Key', hexKey())
        .send({ content: turn })
      expect(res.body.code).toBe(CODE.OK)
      await waitFor(() => runService.stateOf(sid)?.state === 'completed')
    }
    return sid
  }

  async function projection(sid: string): Promise<ProjectionMsg[]> {
    const res = await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))
    expect(res.body.code).toBe(CODE.OK)
    return (res.body.data.messages ?? res.body.data) as ProjectionMsg[]
  }

  beforeAll(async () => {
    installAbortRejectionGuard()
    const dir = mkdtempSync(path.join(tmpdir(), 'sessions-history-'))
    cleanupDirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma, 'hist-user1', 'pw-hist1-secure')
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
    sink = makeSink()
    hub.register(user.id, sink.sink)

    const registry = new ProviderRegistry(prisma, {
      llmApiKey: 'test-key',
      modelFactory: async () => new ScriptedChatModel(currentScript),
    })
    runService = new RunService({
      prisma,
      registry,
      saver: new PrismaCheckpointSaver(prisma),
      gate: new ConcurrencyGate({ globalLimit: 8, loadUserLimit: async () => 8 }),
      hub,
      primitives: fakePrimitives({
        execBehavior: async (_c, cmd) => {
          if (slowExec) await new Promise((r) => setTimeout(r, 200))
          return { exitCode: 0, stdout: cmd.join(' '), stderr: '' }
        },
      }).primitives,
      resolveWikiContainer: () => 'researcher-wiki-u1',
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
        return Promise.resolve()
      },
      sandboxes: {
        remove: async (sid) => {
          removeCalls.push(sid)
          return 'removed'
        },
        fork: async (source, target) => {
          forkCalls.push([source, target])
          if (forkThrows) throw new Error('simulated docker fork failure')
          return forkOutcome
        },
      },
    })
    runService.setRecordTurn((p) => sessions.recordTurn(p))

    const app = createApp({ prisma, events: { hub }, sessions: { service: sessions } })
    request = supertest(app) as unknown as SuperTest<Test>

    const res = await login(request, 'hist-user1', 'pw-hist1-secure')
    access = res.access!
  }, 30_000)

  afterAll(async () => {
    await prisma.$disconnect()
  })

  afterEach(async () => {
    currentScript = []
    slowExec = false
    forkOutcome = 'copied'
    forkCalls = []
    forkThrows = false
    removeCalls = []
    await prisma.configMeta.upsert({
      where: { id: 1 },
      update: { version: { increment: 1 } },
      create: { id: 1, version: 2 },
    })
  })

  // ---- rewind（story 16 + #770 软删 + invalidated 帧）----

  it('rewind 到第一轮锚点：指针换锚 + 旧分支行软删不物理删 + 投影与锚点时刻一致 + invalidated 帧', async () => {
    const sid = await seedConversation('rewind 会话', ['第一问', '第二问'])
    const before = await projection(sid)
    expect(before).toHaveLength(4) // 2 user + 2 assistant
    const firstAssistant = before.find((m) => m.role === 'assistant' && m.content === '回复:第一问')
    expect(firstAssistant?.anchorCheckpointId).toBeTruthy()

    const res = await request
      .post(`/api/v1/sessions/${sid}/rewind`)
      .set(bearer(access))
      .send({ messageId: firstAssistant!.id })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(CODE.OK)
    expect(res.body.data).toMatchObject({ sessionId: sid, activeCheckpointId: firstAssistant!.anchorCheckpointId })

    // 投影 = 锚点时刻（第一轮两行）；轮 2 消失
    const after = await projection(sid)
    expect(after.map((m) => m.id)).toEqual([before[0]!.id, before[1]!.id])

    // 软删存档（#770）：行不物理删、archivedAt 置位；锚点链行不打标记
    const rows = await prisma.sessionMessage.findMany({ where: { sessionId: sid }, orderBy: { turn: 'asc' } })
    expect(rows).toHaveLength(4)
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(before[0]!.id)?.archivedAt).toBeNull()
    expect(byId.get(before[1]!.id)?.archivedAt).toBeNull()
    expect(byId.get(before[2]!.id)?.archivedAt).not.toBeNull()
    expect(byId.get(before[3]!.id)?.archivedAt).not.toBeNull()

    // checkpoint 软删：轮 2 锚点行 archivedAt 置位（锚点链祖先行不动）
    const secondAnchor = before[3]!.anchorCheckpointId!
    const cp2 = await prisma.checkpoint.findUnique({
      where: { threadId_checkpointNs_checkpointId: { threadId: sid, checkpointNs: '', checkpointId: secondAnchor } },
    })
    expect(cp2?.archivedAt).not.toBeNull()
    const cp1 = await prisma.checkpoint.findUnique({
      where: {
        threadId_checkpointNs_checkpointId: {
          threadId: sid,
          checkpointNs: '',
          checkpointId: firstAssistant!.anchorCheckpointId!,
        },
      },
    })
    expect(cp1?.archivedAt).toBeNull()

    // session.invalidated{reason:rewind} 帧断言（S1 验收）
    const invalidated = frameEvents(sink.frames).filter((e) => e.type === 'session.invalidated')
    const last = invalidated[invalidated.length - 1]
    expect(last).toMatchObject({ sessionId: sid, payload: { reason: 'rewind' } })
  })

  it('rewind 后发消息：从锚点分叉续跑（parent=锚点）+ 投影新轮可见 + 终态指针推进', async () => {
    const sid = await seedConversation('分叉会话', ['问 A', '问 B'])
    const before = await projection(sid)
    const firstAssistant = before.find((m) => m.role === 'assistant' && m.content === '回复:问 A')!
    const anchor = firstAssistant.anchorCheckpointId!

    const rw = await request.post(`/api/v1/sessions/${sid}/rewind`).set(bearer(access)).send({ messageId: firstAssistant.id })
    expect(rw.body.code).toBe(CODE.OK)

    currentScript.push(new AIMessage({ content: '重来的回答' }))
    const res = await request
      .post(`/api/v1/sessions/${sid}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey())
      .send({ content: '改写的问题' })
    expect(res.body.code).toBe(CODE.OK)
    await waitFor(() => runService.stateOf(sid)?.state === 'completed')

    // 投影：第一轮 + 新轮（旧分支轮 2 不可见）
    const after = await projection(sid)
    expect(after.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(after.map((m) => m.content)).toEqual(['问 A', '回复:问 A', '改写的问题', '重来的回答'])

    // 分叉断言：新锚点的祖先链含 rewind 锚点（本轮 run 的超步链挂在锚点之下——终态锚的
    // 直接 parent 是同 run 倒数第二个超步，链尾才接 rewind 锚点）
    const newRow = after[3]!
    expect(newRow.anchorCheckpointId).toBeTruthy()
    const cps = await prisma.checkpoint.findMany({
      where: { threadId: sid },
      select: { checkpointId: true, parentCheckpointId: true },
    })
    const parentOf = new Map(cps.map((c) => [c.checkpointId, c.parentCheckpointId]))
    let cur: string | null | undefined = newRow.anchorCheckpointId
    const ancestors = new Set<string>()
    while (cur && !ancestors.has(cur)) {
      ancestors.add(cur)
      cur = parentOf.get(cur)
    }
    expect(ancestors.has(anchor)).toBe(true)

    // 指针推进：completed 后 activeCheckpointId = 新锚点
    const session = await prisma.session.findUnique({ where: { id: sid } })
    expect(session?.activeCheckpointId).toBe(newRow.anchorCheckpointId)
  })

  it('rewind 校验面：他人/不存在 50002 同码防探测；非法锚点 90002；running 中 50005', async () => {
    const sid = await seedConversation('校验会话', ['一问'])
    const rows = await projection(sid)
    const assistant = rows.find((m) => m.role === 'assistant')!

    const other = await seedUser(prisma, 'hist-user2', 'pw-hist2-secure')
    const otherSession = await prisma.session.create({
      data: { id: 'hist-other', ownerId: other.id, containerId: 'researcher-sandbox-hist-other', title: '' },
    })
    const denied = await request
      .post('/api/v1/sessions/hist-other/rewind')
      .set(bearer(access))
      .send({ messageId: assistant.id })
    const missing = await request
      .post('/api/v1/sessions/no-such-hist/rewind')
      .set(bearer(access))
      .send({ messageId: assistant.id })
    expect(denied.body.code).toBe(CODE.SESSION_NOT_FOUND)
    expect(JSON.stringify(denied.body)).toBe(JSON.stringify(missing.body))
    void otherSession

    // 锚点行不存在（他人会话消息 id）→ 90002
    const badAnchor = await request
      .post(`/api/v1/sessions/${sid}/rewind`)
      .set(bearer(access))
      .send({ messageId: 'no-such-message' })
    expect(badAnchor.body.code).toBe(CODE.VALIDATION_FAILED)

    // 空会话（无 checkpoint）→ 90002
    const emptyCreated = await request.post('/api/v1/sessions').set(bearer(access)).send({ title: '空会话' })
    const emptyId = emptyCreated.body.data.id as string
    const emptyRewind = await request
      .post(`/api/v1/sessions/${emptyId}/rewind`)
      .set(bearer(access))
      .send({ messageId: 'whatever' })
    expect(emptyRewind.body.code).toBe(CODE.VALIDATION_FAILED)

    // running 中 rewind → 50005（在飞互斥：换锚会作废在飞链）
    slowExec = true
    const runningSid = await request.post('/api/v1/sessions').set(bearer(access)).send({ title: '在飞会话' })
    const runningId = runningSid.body.data.id as string
    currentScript.push(toolCallAi('slow-1', 'execute', { command: 'slow' }), new AIMessage({ content: '慢回复' }))
    void (await request
      .post(`/api/v1/sessions/${runningId}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey())
      .send({ content: '触发慢跑' }))
    await waitFor(() => runService.stateOf(runningId)?.state === 'running')
    const busy = await request
      .post(`/api/v1/sessions/${runningId}/rewind`)
      .set(bearer(access))
      .send({ messageId: assistant.id })
    expect(busy.body.code).toBe(CODE.RUN_IN_PROGRESS)
    await waitFor(() => runService.stateOf(runningId)?.state === 'completed')
  })

  // ---- fork（story 18/20 + #768 D7）----

  it('fork 全件：溯源行 + checkpoint/消息/journal/attachments 截断复制 + created{source:fork} 帧 + 沙箱字面复制调用', async () => {
    const sid = await seedConversation('fork 源会话', ['问 1', '问 2'])
    const before = await projection(sid)
    const firstUser = before[0]!
    const firstAssistant = before.find((m) => m.role === 'assistant' && m.content === '回复:问 1')!
    const anchor = firstAssistant.anchorCheckpointId!

    // seed journal：锚点链行（cp=anchor）+ 被截断行（cp=轮2 锚点）
    const secondAnchor = before[3]!.anchorCheckpointId!
    await prisma.fileJournal.create({
      data: { sessionId: sid, checkpointId: anchor, seq: 1, op: 'write', path: 'lab/notes.md', toolCallId: 'tc-j1', applied: true },
    })
    await prisma.fileJournal.create({
      data: { sessionId: sid, checkpointId: secondAnchor, seq: 2, op: 'write', path: 'lab/late.md', toolCallId: 'tc-j2', applied: true },
    })
    // seed attachments：挂第一轮 user 行（应复制）+ 挂第二轮 user 行（FK 交集：不复制）
    await prisma.attachment.create({
      data: { sessionId: sid, id: 'att-1', ownerId: (await prisma.session.findUnique({ where: { id: sid } }))!.ownerId, messageId: firstUser.id, fileName: 'a.txt', mimeType: 'text/plain', size: 3, sha256: 'x', path: '/lab/uploads/att-1/a.txt' },
    })
    await prisma.attachment.create({
      data: { sessionId: sid, id: 'att-2', ownerId: (await prisma.session.findUnique({ where: { id: sid } }))!.ownerId, messageId: before[2]!.id, fileName: 'b.txt', mimeType: 'text/plain', size: 3, sha256: 'y', path: '/lab/uploads/att-2/b.txt' },
    })

    const res = await request
      .post(`/api/v1/sessions/${sid}/fork`)
      .set(bearer(access))
      .send({ messageId: firstAssistant.id })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(CODE.OK)
    const forked = res.body.data.session as { id: string; title: string; createdAt: string }
    expect(forked.id).not.toBe(sid)

    // 溯源行：parentSessionKey + forkSourceJson + activeCheckpointId = 切点
    const row = await prisma.session.findUnique({ where: { id: forked.id } })
    expect(row?.parentSessionKey).toBe(sid)
    expect(row?.activeCheckpointId).toBe(anchor)
    const forkSource = JSON.parse(row?.forkSourceJson ?? '{}') as { sourceSessionId?: string; sourceCheckpointId?: string }
    expect(forkSource.sourceSessionId).toBe(sid)
    expect(forkSource.sourceCheckpointId).toBe(anchor)

    // checkpoint 截断复制：祖先链行在新 thread（同 checkpointId），切点后行不复制
    const forkedCps = await prisma.checkpoint.findMany({ where: { threadId: forked.id } })
    expect(forkedCps.length).toBeGreaterThan(0)
    expect(forkedCps.map((c) => c.checkpointId)).toContain(anchor)
    expect(forkedCps.map((c) => c.checkpointId)).not.toContain(secondAnchor)
    // blob 字节级一致（自包含直读）
    const srcBlob = await prisma.checkpoint.findUnique({
      where: { threadId_checkpointNs_checkpointId: { threadId: sid, checkpointNs: '', checkpointId: anchor } },
    })
    expect(forkedCps.find((c) => c.checkpointId === anchor)?.blob).toEqual(srcBlob?.blob)

    // 消息行截断复制（id 新生成——全局主键；turn/role/content 原样）：第一轮两行，轮 2 不复制
    const forkedMsgs = await prisma.sessionMessage.findMany({ where: { sessionId: forked.id }, orderBy: { turn: 'asc' } })
    expect(forkedMsgs.map((m) => [m.turn, m.role, m.content])).toEqual([
      [1, 'user', '问 1'],
      [2, 'assistant', '回复:问 1'],
    ])

    // journal 继承：锚点链行复制（seq 保留），切点后行不复制
    const forkedJournal = await prisma.fileJournal.findMany({ where: { sessionId: forked.id } })
    expect(forkedJournal).toHaveLength(1)
    expect(forkedJournal[0]).toMatchObject({ checkpointId: anchor, seq: 1, toolCallId: 'tc-j1' })

    // attachments 复制：挂第一轮行复制、attachmentId 不改；挂第二轮行留在源
    const forkedAtt = await prisma.attachment.findMany({ where: { sessionId: forked.id } })
    expect(forkedAtt.map((a) => a.id)).toEqual(['att-1'])
    // messageId 随映射改指新行（FK 完整）
    expect(forkedAtt[0]?.messageId).toBe(forkedMsgs[0]?.id)

    // 投影 = 切点时刻；源会话不受影响
    const forkedProjection = await projection(forked.id)
    expect(forkedProjection.map((m) => m.content)).toEqual(['问 1', '回复:问 1'])
    expect((await projection(sid))).toHaveLength(4)

    // 沙箱字面复制调用（fake 面：source → target 传递正确）
    expect(forkCalls).toEqual([[sid, forked.id]])

    // session.created{source:fork} 帧
    const created = frameEvents(sink.frames).filter((e) => e.type === 'session.created')
    const last = created[created.length - 1]
    expect(last).toMatchObject({ sessionId: forked.id, payload: { source: 'fork', session: { id: forked.id } } })

    // fork 后发消息：state 从切点 checkpoint 起步（invocation 带指针锚点——新轮挂在切点链下，
    // 源会话轮 2 的内容不进入新 thread 的 state）
    currentScript.push(new AIMessage({ content: 'fork 后的回答' }))
    const cont = await request
      .post(`/api/v1/sessions/${forked.id}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey())
      .send({ content: 'fork 后的问题' })
    expect(cont.body.code).toBe(CODE.OK)
    await waitFor(() => runService.stateOf(forked.id)?.state === 'completed')
    const after = await projection(forked.id)
    expect(after.map((m) => m.content)).toEqual(['问 1', '回复:问 1', 'fork 后的问题', 'fork 后的回答'])
    // 新轮锚点祖先链含切点（state 真从切点起步，非从源会话链头）
    const forkedCpsAll = await prisma.checkpoint.findMany({
      where: { threadId: forked.id },
      select: { checkpointId: true, parentCheckpointId: true },
    })
    const parentOfFork = new Map(forkedCpsAll.map((c) => [c.checkpointId, c.parentCheckpointId]))
    let walk: string | null | undefined = after[3]!.anchorCheckpointId
    const chain = new Set<string>()
    while (walk && !chain.has(walk)) {
      chain.add(walk)
      walk = parentOfFork.get(walk)
    }
    expect(chain.has(anchor)).toBe(true)
    expect(chain.has(secondAnchor)).toBe(false)
  })

  it('fork 源沙箱已删：空起步 + 系统消息行入投影', async () => {
    const sid = await seedConversation('缺沙箱源', ['唯一问'])
    const before = await projection(sid)
    const assistant = before.find((m) => m.role === 'assistant')!
    forkOutcome = 'source-missing'

    const res = await request
      .post(`/api/v1/sessions/${sid}/fork`)
      .set(bearer(access))
      .send({ messageId: assistant.id })
    expect(res.body.code).toBe(CODE.OK)
    const forked = res.body.data.session as { id: string }

    const msgs = await projection(forked.id)
    const sys = msgs.find((m) => m.role === 'system')
    expect(sys?.content).toContain('沙箱')
    expect(sys?.content).toContain('空白')
  })

  it('fork 校验面：他人/不存在 50002 防探测；非法切点 90002；缺省切点 = 活跃头', async () => {
    const sid = await seedConversation('fork 校验', ['一问'])
    const denied = await request
      .post('/api/v1/sessions/others-fork/rewind'.replace('/rewind', '/fork'))
      .set(bearer(access))
      .send({})
    expect(denied.body.code).toBe(CODE.SESSION_NOT_FOUND)

    const bad = await request
      .post(`/api/v1/sessions/${sid}/fork`)
      .set(bearer(access))
      .send({ messageId: 'no-such-message' })
    expect(bad.body.code).toBe(CODE.VALIDATION_FAILED)

    // 缺省切点 = 最新锚点（整会话 fork）：投影全量
    const res = await request.post(`/api/v1/sessions/${sid}/fork`).set(bearer(access)).send({})
    expect(res.body.code).toBe(CODE.OK)
    const forked = res.body.data.session as { id: string }
    const msgs = await projection(forked.id)
    expect(msgs).toHaveLength(2)
  })

  // ---- R 评审回归面：失败轮归档口径 + 归档行拒绝 + fork 补偿 ----

  it('rewind 前失败尾部随 rewind 归档（投影 ≡ 锚点时刻）；rewind 后失败轮在重试时清场（无双 user 并列）', async () => {
    const sid = await seedConversation('失败尾部会话', ['第一问'])

    // 失败轮（锚=null）：tool 事件喂非空聚合后脚本耗尽 → run.failed（runnerRecovery 先例同型）
    currentScript.push(toolCallAi('fail-tc-1', 'execute', { command: 'echo hi' }))
    const failedSend = await request
      .post(`/api/v1/sessions/${sid}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey())
      .send({ content: '会失败的问' })
    expect(failedSend.body.code).toBe(CODE.OK)
    await waitFor(() => runService.stateOf(sid)?.state === 'failed')

    const withFail = await projection(sid)
    expect(withFail.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(withFail[3]!.anchorCheckpointId).toBeNull()

    // rewind 到第一轮 → 失败尾部（锚点之后、无锚）随 rewind 归档；失败轮超步 checkpoint
    //（不经旧 head 的死亡分叉）由差集口径一并归档
    const firstAssistant = withFail[1]!
    const rw = await request
      .post(`/api/v1/sessions/${sid}/rewind`)
      .set(bearer(access))
      .send({ messageId: firstAssistant.id })
    expect(rw.body.code).toBe(CODE.OK)
    expect((await projection(sid)).map((m) => m.id)).toEqual([withFail[0]!.id, withFail[1]!.id])
    const failRows = await prisma.sessionMessage.findMany({
      where: { id: { in: [withFail[2]!.id, withFail[3]!.id] } },
    })
    expect(failRows.every((r) => r.archivedAt !== null)).toBe(true)
    expect(await prisma.checkpoint.count({ where: { threadId: sid, archivedAt: { not: null } } })).toBeGreaterThan(0)

    // rewind 态下再发一轮（失败）→ 残留可见（刚发生）；重试 → 上一条失败残留清场
    currentScript.push(toolCallAi('fail-tc-2', 'execute', { command: 'echo hi' }))
    const retryFail = await request
      .post(`/api/v1/sessions/${sid}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey())
      .send({ content: '失败尝试' })
    expect(retryFail.body.code).toBe(CODE.OK)
    await waitFor(() => runService.stateOf(sid)?.state === 'failed')
    expect(await prisma.sessionMessage.count({ where: { sessionId: sid, archivedAt: null } })).toBe(4)

    currentScript.push(new AIMessage({ content: '最终回答' }))
    const retry = await request
      .post(`/api/v1/sessions/${sid}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey())
      .send({ content: '重试的问题' })
    expect(retry.body.code).toBe(CODE.OK)
    await waitFor(() => runService.stateOf(sid)?.state === 'completed')

    // 投影 = 锚点时刻 + 重试轮（失败尝试两行归档——不双 user 并列）
    expect((await projection(sid)).map((m) => m.content)).toEqual(['第一问', '回复:第一问', '重试的问题', '最终回答'])
    const rows = await prisma.sessionMessage.findMany({ where: { sessionId: sid }, orderBy: { turn: 'asc' } })
    const byTurn = (t: number) => rows.find((r) => r.turn === t)
    expect(byTurn(5)?.content).toBe('失败尝试')
    expect(byTurn(5)?.archivedAt).not.toBeNull()
    expect(byTurn(6)?.archivedAt).not.toBeNull() // 失败 assistant 行（无锚）
    expect(byTurn(7)?.content).toBe('重试的问题')
    expect(byTurn(7)?.archivedAt).toBeNull()
    expect(byTurn(8)?.content).toBe('最终回答')
  })

  it('归档行不可作锚点/切点：向前 rewind 与 fork 归档消息均 90002；同锚点重复 rewind 合法 no-op', async () => {
    const sid = await seedConversation('归档拒绝会话', ['甲问', '乙问'])
    const before = await projection(sid)
    const a1 = before.find((m) => m.role === 'assistant' && m.content === '回复:甲问')!
    const a2 = before.find((m) => m.role === 'assistant' && m.content === '回复:乙问')!
    const rw = await request
      .post(`/api/v1/sessions/${sid}/rewind`)
      .set(bearer(access))
      .send({ messageId: a1.id })
    expect(rw.body.code).toBe(CODE.OK)

    // 向前 rewind 到已归档的乙轮（assistant / user 行均拒）→ 90002（#770 无恢复入口）
    const fwdA = await request
      .post(`/api/v1/sessions/${sid}/rewind`)
      .set(bearer(access))
      .send({ messageId: a2.id })
    expect(fwdA.body.code).toBe(CODE.VALIDATION_FAILED)
    const fwdU = await request
      .post(`/api/v1/sessions/${sid}/rewind`)
      .set(bearer(access))
      .send({ messageId: before[2]!.id })
    expect(fwdU.body.code).toBe(CODE.VALIDATION_FAILED)
    // 归档行不可作 fork 切点 → 90002
    const fk = await request
      .post(`/api/v1/sessions/${sid}/fork`)
      .set(bearer(access))
      .send({ messageId: a2.id })
    expect(fk.body.code).toBe(CODE.VALIDATION_FAILED)

    // 同一锚点重复 rewind（锚 = 指针）→ 合法 no-op，投影不变
    const again = await request
      .post(`/api/v1/sessions/${sid}/rewind`)
      .set(bearer(access))
      .send({ messageId: a1.id })
    expect(again.body.code).toBe(CODE.OK)
    expect((await projection(sid)).map((m) => m.id)).toEqual([before[0]!.id, before[1]!.id])
  })

  it('rewind 后 fork：缺省切点 = 指针（非归档轮）；沙箱复制失败 → INTERNAL 信封 + 补偿删会话行 + 收沙箱', async () => {
    const sid = await seedConversation('rewind 后 fork 源', ['一问', '二问'])
    const before = await projection(sid)
    const a1 = before.find((m) => m.role === 'assistant' && m.content === '回复:一问')!
    const rw = await request
      .post(`/api/v1/sessions/${sid}/rewind`)
      .set(bearer(access))
      .send({ messageId: a1.id })
    expect(rw.body.code).toBe(CODE.OK)

    // 缺省 fork（无 messageId）→ 切点 = 指针（甲轮锚，非归档的乙轮链头）
    const res = await request.post(`/api/v1/sessions/${sid}/fork`).set(bearer(access)).send({})
    expect(res.body.code).toBe(CODE.OK)
    const forked = res.body.data.session as { id: string }
    expect((await prisma.session.findUnique({ where: { id: forked.id } }))?.activeCheckpointId).toBe(
      a1.anchorCheckpointId,
    )
    const fkMsgs = await prisma.sessionMessage.findMany({
      where: { sessionId: forked.id },
      orderBy: { turn: 'asc' },
    })
    expect(fkMsgs.map((m) => m.content)).toEqual(['一问', '回复:一问'])

    // 沙箱复制失败（补偿路径）：INTERNAL 信封 + 会话行删除（列表不可见）+ 收沙箱
    forkThrows = true
    const failedFork = await request.post(`/api/v1/sessions/${sid}/fork`).set(bearer(access)).send({})
    expect(failedFork.body.code).toBe(CODE.INTERNAL)
    const targetId = forkCalls[forkCalls.length - 1]![1]
    expect(await prisma.session.findUnique({ where: { id: targetId } })).toBeNull()
    expect(removeCalls).toContain(targetId)
    const list = await request.get('/api/v1/sessions').set(bearer(access))
    expect((list.body.data.sessions as { id: string }[]).some((s) => s.id === targetId)).toBe(false)
  })
})
