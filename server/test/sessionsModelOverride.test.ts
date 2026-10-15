// 会话模型覆盖双入口信封级集成（#978 · ADR 0019/0020）：PATCH preferredModel 与 /model
// 斜杠命令同真源读写——同一 zod schema（preferredModelSchema 单源）+ service 写路径单点
//（writePreferredModel 事务内 helper）+ 投影/事件同形状（零新增事件类型）。
//
// 验收口径（#978）：PATCH 对象/null 清空、能力 none 带 effort 拒 90002、任一端写入投影
//（列表行 + 详情）与 session.updated 均可读、「default」/null 双端清空同语义、存量无 effort
// 旧行宽松读、全程 #312 信封。运行层零注入属票②锁——本文件只验存储/接口面。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import supertest, { type SuperTest, type Test } from 'supertest'
import { createPrismaClient } from '../src/prisma'
import { createApp } from '../src/app'
import type { PrismaClient } from '../src/generated/prisma/client'
import { StreamHub, type StreamSink } from '../src/events/hub'
import { seedUser, login, bearer } from './helpers'
import { ProviderRegistry } from '../src/runner/providerRegistry'
import { RunService } from '../src/runner/runtime/runService'
import { SessionService } from '../src/sessions/service'
import { CODE } from '../src/codes'

const LAB = 'researcher-sandbox-seed'

interface TestSinkBox {
  sink: StreamSink
  frames: string[]
}

function makeSink(): TestSinkBox {
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

// 帧字符串 → {type, sessionId?, payload}（sessionsApi.test.ts 同款逆编码）
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

const hexKey = (n: number) => n.toString(16).padStart(32, '0')

describe('会话模型覆盖双入口（#978）', () => {
  let prisma: PrismaClient
  let request: SuperTest<Test>
  let hub: StreamHub
  let sink: TestSinkBox
  let access: string

  async function createSession(title = ''): Promise<string> {
    const res = await request.post('/api/v1/sessions').set(bearer(access)).send({ title })
    expect(res.body.code).toBe(CODE.OK)
    return (res.body.data as { id: string }).id
  }

  beforeAll(async () => {
    const dir = mkdtempSync(`${tmpdir()}/sess-override-`)
    const dbPath = `${dir}/test.db`
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)

    const user = await seedUser(prisma, 'ov-user1', 'pw-ov1-secure')
    await prisma.session.create({ data: { id: 'ov-seed', ownerId: user.id, containerId: LAB, title: '' } })
    await prisma.modelProvider.create({
      data: {
        ownerId: user.id,
        providerId: 'prov-1',
        presetId: 'openai',
        modelsJson: JSON.stringify([{ id: 'model-x' }]),
      },
    })

    hub = new StreamHub()
    sink = makeSink()
    hub.register(user.id, sink.sink)

    const registry = new ProviderRegistry(prisma, { llmApiKey: 'test-key' })
    const runService = new RunService({
      prisma,
      registry,
      saver: {} as never, // 本文件不触发 run 执行（/model 命令零 dispatch；消息面非本域）
      gate: { acquire: async () => () => {}, release: () => {} } as never,
      hub,
      primitives: {} as never,
      resolveWikiContainer: () => 'researcher-wiki-u1',
    })
    const sessions = new SessionService({
      prisma,
      hub,
      // resolveModelSelection 走真 RunService（单源收编路径的真实消费面）；其余 gateway
      // 成员本文件不可达（/model 命令零 dispatch、无消息发送、无 run 状态观测）。
      runService: {
        resolveModelSelection: (ownerId, args) => runService.resolveModelSelection(ownerId, args),
        stateOf: () => undefined,
        abort: () => false,
        quotaFull: async () => false,
        buildMessageCommand: async () => {
          throw new Error('not used in this spec')
        },
        buildResumeCommand: () => {
          throw new Error('not used in this spec')
        },
        inFlightProjection: async () => undefined,
      },
      dispatch: async () => {},
    })

    const app = createApp({ prisma, events: { hub }, sessions: { service: sessions } })
    request = supertest(app) as unknown as SuperTest<Test>
    access = (await login(request, 'ov-user1', 'pw-ov1-secure')).access!
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('PATCH preferredModel 对象：200 + 响应/列表行/投影三面可读（含 effort）', async () => {
    const sid = await createSession()
    const res = await request
      .patch(`/api/v1/sessions/${sid}`)
      .set(bearer(access))
      .send({ preferredModel: { providerId: 'prov-1', modelId: 'model-x', effort: 'high' } })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(CODE.OK)
    expect(res.body.data.preferredModel).toEqual({ providerId: 'prov-1', modelId: 'model-x', effort: 'high' })

    const list = await request.get('/api/v1/sessions').set(bearer(access))
    const row = (list.body.data.sessions as Array<{ id: string; preferredModel: unknown }>).find((s) => s.id === sid)
    expect(row!.preferredModel).toEqual({ providerId: 'prov-1', modelId: 'model-x', effort: 'high' })

    const projection = await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))
    expect(projection.body.data.preferredModel).toEqual({ providerId: 'prov-1', modelId: 'model-x', effort: 'high' })
  })

  it('PATCH 写后广播 session.updated {sessionId, model(含 effort), appliesTo:"next-run"}——零新增事件类型', async () => {
    const sid = await createSession()
    await request
      .patch(`/api/v1/sessions/${sid}`)
      .set(bearer(access))
      .send({ preferredModel: { providerId: 'prov-1', modelId: 'model-x', effort: 'max' } })
    const evs = frameEvents(sink.frames).filter((e) => e.type === 'session.updated')
    expect(evs.at(-1)).toMatchObject({
      sessionId: sid,
      payload: { sessionId: sid, model: { providerId: 'prov-1', modelId: 'model-x', effort: 'max' }, appliesTo: 'next-run' },
    })
  })

  it('PATCH null 清空：投影读 null + 事件 model null（/model default 同语义）', async () => {
    const sid = await createSession()
    await request
      .patch(`/api/v1/sessions/${sid}`)
      .set(bearer(access))
      .send({ preferredModel: { providerId: 'prov-1', modelId: 'model-x' } })
    const cleared = await request
      .patch(`/api/v1/sessions/${sid}`)
      .set(bearer(access))
      .send({ preferredModel: null })
    expect(cleared.body.code).toBe(CODE.OK)
    expect(cleared.body.data.preferredModel).toBeNull()

    const projection = await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))
    expect(projection.body.data.preferredModel).toBeNull()

    const evs = frameEvents(sink.frames).filter((e) => e.type === 'session.updated')
    expect(evs.at(-1)).toMatchObject({ sessionId: sid, payload: { sessionId: sid, model: null, appliesTo: 'next-run' } })
  })

  it('title + preferredModel 同请求：两款既有形状各广播一条（{session} + {model}）', async () => {
    const sid = await createSession()
    await request
      .patch(`/api/v1/sessions/${sid}`)
      .set(bearer(access))
      .send({ title: '改名带覆盖', preferredModel: { providerId: 'prov-1', modelId: 'model-x' } })
    expect((await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))).body.data.title).toBe('改名带覆盖')
    const evs = frameEvents(sink.frames).filter((e) => e.type === 'session.updated').slice(-2)
    const payloads = evs.map((e) => e.payload) as Array<Record<string, unknown>>
    expect(payloads.some((p) => (p.session as { title?: string })?.title === '改名带覆盖')).toBe(true)
    expect(payloads.some((p) => 'model' in p && (p as { appliesTo?: string }).appliesTo === 'next-run')).toBe(true)
  })

  it('能力 none（kimi-k2）带 effort → 90002；不带 effort → 200（能力表 presets 单源 super-refine）', async () => {
    const sid = await createSession()
    const rejected = await request
      .patch(`/api/v1/sessions/${sid}`)
      .set(bearer(access))
      .send({ preferredModel: { providerId: 'prov-1', modelId: 'kimi-k2', effort: 'low' } })
    expect(rejected.body.code).toBe(CODE.VALIDATION_FAILED)
    expect(rejected.body.data).toMatchObject({ preferredModel: expect.any(Array) })
    // 拒写零残留
    expect((await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))).body.data.preferredModel).toBeNull()

    const allowed = await request
      .patch(`/api/v1/sessions/${sid}`)
      .set(bearer(access))
      .send({ preferredModel: { providerId: 'prov-1', modelId: 'kimi-k2' } })
    expect(allowed.body.code).toBe(CODE.OK)
    expect(allowed.body.data.preferredModel).toEqual({ providerId: 'prov-1', modelId: 'kimi-k2' })
  })

  it('非法 effort 值 / 双字段全缺 / 越权 → 90002 / 90002 / 50002', async () => {
    const sid = await createSession()
    const badEffort = await request
      .patch(`/api/v1/sessions/${sid}`)
      .set(bearer(access))
      .send({ preferredModel: { providerId: 'prov-1', modelId: 'model-x', effort: 'medium' } })
    expect(badEffort.body.code).toBe(CODE.VALIDATION_FAILED)

    const empty = await request.patch(`/api/v1/sessions/${sid}`).set(bearer(access)).send({})
    expect(empty.body.code).toBe(CODE.VALIDATION_FAILED)

    const other = await seedUser(prisma, 'ov-user2', 'pw-ov2-secure')
    await prisma.session.create({ data: { id: 'ov-other', ownerId: other.id, containerId: LAB, title: '' } })
    const denied = await request
      .patch('/api/v1/sessions/ov-other')
      .set(bearer(access))
      .send({ preferredModel: { providerId: 'prov-1', modelId: 'model-x' } })
    expect(denied.body.code).toBe(CODE.SESSION_NOT_FOUND)
  })

  it('双入口互通：/model 斜杠写 → 投影可读；PATCH 覆写 → 再读同真源；/model default 与 null 清空同语义', async () => {
    const sid = await createSession()
    const send = (content: string, key: number) =>
      request
        .post(`/api/v1/sessions/${sid}/messages`)
        .set(bearer(access))
        .set('Idempotency-Key', hexKey(key))
        .send({ content })

    const picked = await send('/model prov-1/model-x', 0xa01)
    expect(picked.body.data.command).toMatchObject({ name: 'model', model: { providerId: 'prov-1', modelId: 'model-x' }, appliesTo: 'next-run' })
    expect((await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))).body.data.preferredModel).toEqual({
      providerId: 'prov-1',
      modelId: 'model-x',
    })

    // PATCH 覆写（同真源单点）→ 斜杠写的 {providerId, modelId} 被整体替换
    await request
      .patch(`/api/v1/sessions/${sid}`)
      .set(bearer(access))
      .send({ preferredModel: { providerId: 'platform', modelId: 'MiniMax-M3', effort: 'low' } })
    expect((await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))).body.data.preferredModel).toEqual({
      providerId: 'platform',
      modelId: 'MiniMax-M3',
      effort: 'low',
    })

    const defaulted = await send('/model default', 0xa02)
    expect(defaulted.body.data.command.model).toBeNull()
    expect((await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))).body.data.preferredModel).toBeNull()
  })

  it('存量无 effort 旧行宽松读：裸 {providerId, modelId} 原样出投影；坏 JSON → null 不炸读', async () => {
    const sid = await createSession()
    // 模拟存量行（无 effort）与坏 JSON 行——不经 zod（历史数据形态）
    await prisma.session.update({ where: { id: sid }, data: { preferredModelJson: '{"providerId":"prov-1","modelId":"model-x"}' } })
    expect((await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))).body.data.preferredModel).toEqual({
      providerId: 'prov-1',
      modelId: 'model-x',
    })
    await prisma.session.update({ where: { id: sid }, data: { preferredModelJson: 'not-json' } })
    expect((await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))).body.data.preferredModel).toBeNull()
    const list = await request.get('/api/v1/sessions').set(bearer(access))
    expect((list.body.data.sessions as Array<{ id: string; preferredModel: unknown }>).find((s) => s.id === sid)!.preferredModel).toBeNull()
  })

  it('session.created 载荷随 summary 加法携带 preferredModel: null（零覆盖默认态）', async () => {
    const sid = await createSession('带标题')
    const evs = frameEvents(sink.frames).filter((e) => e.type === 'session.created')
    expect(evs.at(-1)).toMatchObject({ sessionId: sid, payload: { source: 'new', session: { id: sid, title: '带标题', preferredModel: null } } })
  })
})
