// #790 通道② S1 信封级集成：wiki-update teammate 全链（验收①③）。
// 真 RunService + TeammateService + 图 + checkpoint + 信箱 + 真实 openwiki 生命周期工具（deep-import
// 契约面）——只假 LLM/Docker/time（teammateRuntime.test.ts harness 先例）。
//
// 验收面：
//   (a) 全链——leader spawn_teammate(kind='wiki-update') 派生 → teammate 图 systemPrompt 含
//       治理驱动提示 → 生命周期工具驱动（begin/submit_plan/next_page → write_file 副本执行 →
//       submit_page → finish）→ finish 触发 base-hash 复检 + 推回（容器树收到 openwiki/** 子树
//       内容与 .claims 旁车，无 .git 条目），run completed。
//   (b) 冲突中止——finish 前改假容器树（模拟轻写通道并发写）→ finish 返回 conflict Result →
//       容器树保持改后状态（推回未发生）→ leader 信箱收到 wiki-conflict 邮件。
//   (c) 中断作废——teammate 停在 interrupt（mailbox wait）→ leader close_teammate（archive→
//       stopTeammate→aborted）→ 容器树无任何变更（中断 = 作废不推回）。
//   (d) /lab 写经组合 backend 仍持 #785 写锁——锁面观察在 S3（wikigenLifecycleTools.test.ts），
//       本文件 (a) 的 write_file 走组合 backend 即其集成面。

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
import { TeammateService } from '../src/runner/teammates/service'
import { SessionService } from '../src/sessions/service'
import { fakePrimitives, ScriptedChatModel, toolCallAi } from './runnerFakes'
import { seedUser, waitFor } from './helpers'

const WIKI = 'researcher-wiki-gen-u1'
const enc = (s: string) => Buffer.from(s, 'utf8')

// ---- 脚本化 LLM：按「首个 human 消息」键控回放序列；条目可为基础 AIMessage 或接收完整
// 消息列表的工厂（生命周期工具的 runId/jobId 是运行期返回值——从 ToolMessage 提取）。 ----
type Reply = AIMessage | ((messages: BaseMessage[]) => Promise<AIMessage> | AIMessage)

function toolResultPayloads(messages: BaseMessage[]): unknown[] {
  const out: unknown[] = []
  for (const m of messages) {
    if (m.getType() !== 'tool') continue
    try {
      out.push(JSON.parse(String(m.content)))
    } catch {
      out.push(undefined)
    }
  }
  return out
}

function findRunId(messages: BaseMessage[]): string {
  for (const payload of toolResultPayloads(messages)) {
    const p = payload as { ok?: boolean; data?: { runId?: string } } | undefined
    if (p?.ok === true && typeof p.data?.runId === 'string') return p.data.runId
  }
  throw new Error('no runId in tool results')
}

function findJobId(messages: BaseMessage[]): string {
  for (const payload of toolResultPayloads(messages)) {
    const p = payload as { ok?: boolean; data?: { job?: { id?: string } } } | undefined
    if (p?.ok === true && typeof p.data?.job?.id === 'string') return p.data.job.id
  }
  throw new Error('no jobId in tool results')
}

class KeyedChatModel extends ScriptedChatModel {
  private positions = new Map<string, number>()
  constructor(
    private readonly replies: Record<string, Reply[]>,
    private readonly onCall?: (task: string, system: string) => void,
  ) {
    super([])
  }
  override async _generate(messages: BaseMessage[]) {
    const input = messages.find((m) => m.getType() === 'human')?.content
    const key = typeof input === 'string' ? input : ''
    const system = JSON.stringify(messages.filter((m) => m.getType() === 'system').map((m) => m.content))
    this.onCall?.(key, system)
    const position = this.positions.get(key) ?? 0
    this.positions.set(key, position + 1)
    const seq = this.replies[key]
    if (!seq || position >= seq.length) throw new Error(`no reply for ${JSON.stringify(key.slice(0, 60))} at ${position}`)
    const reply = seq[position]!
    const message = typeof reply === 'function' ? await reply(messages) : reply
    return { generations: [{ message, text: typeof message.content === 'string' ? message.content : '' }] }
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function seededFake() {
  const fake = fakePrimitives()
  fake.trees.set(
    WIKI,
    new Map<string, Buffer | 'dir'>([
      ['/wiki', 'dir'],
      ['/wiki/concepts', 'dir'],
      ['/wiki/concepts/existing.md', enc('# Existing\n\nSeed page.\n')],
    ]),
  )
  return fake
}

async function harness(replies: Record<string, Reply[]>, fake: ReturnType<typeof seededFake>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wikigen-runtime-'))
  const dbPath = path.join(dir, 'test.db')
  const sqlite = new Database(dbPath)
  sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma/init.sql'), 'utf8'))
  sqlite.close()
  const prisma = createPrismaClient(`file:${dbPath}`)
  const owner = await seedUser(prisma, 'wikigen-user', 'wikigen-password')
  await prisma.modelProvider.create({ data: {
    ownerId: owner.id, providerId: 'wikigen-provider', presetId: 'openai',
    modelsJson: JSON.stringify([{ id: 'model-x' }]),
  } })
  const hub = new StreamHub()
  const events: CatalogEvent[] = []
  hub.register(owner.id, { send: (frame) => {
    const data = /^data: (.+)$/m.exec(frame)?.[1]
    if (data) events.push(JSON.parse(data) as CatalogEvent)
    return true
  }, close: () => {} })
  const gate = new ConcurrencyGate({ globalLimit: 1, loadUserLimit: async () => 1 })
  const teammates = new TeammateService(prisma)
  const modelCalls: Array<{ task: string; system: string }> = []
  const service = new RunService({
    prisma, hub, gate, teammates, saver: new PrismaCheckpointSaver(prisma),
    registry: new ProviderRegistry(prisma, { llmApiKey: 'fake', modelFactory: async () => new KeyedChatModel(replies, (task, system) => modelCalls.push({ task, system })) }),
    primitives: fake.primitives, resolveWikiContainer: () => WIKI,
  })
  const executions: Promise<void>[] = []
  const delayed: Array<{ command: Parameters<RunService['execute']>[0]; delayMs: number }> = []
  const dispatch = async (command: Parameters<RunService['execute']>[0], delayMs = 0) => {
    if (delayMs > 0) { delayed.push({ command, delayMs }); return }
    const execution = service.execute(command)
    execution.catch(() => {})
    executions.push(execution)
  }
  service.setTeammateDispatcher(dispatch)
  teammates.setWakeHandler((threadId, teammateId, waitId) => service.wakeMailbox(threadId, teammateId, waitId))
  const sessions = new SessionService({ prisma, hub, runService: service, dispatch })
  service.setRecordTurn((payload) => sessions.recordTurn(payload))
  const request = supertest(createApp({ prisma, events: { hub }, sessions: { service: sessions } }))
  const access = await signAccessToken(owner.id)
  const auth = { Authorization: `Bearer ${access}` }
  const created = await request.post('/api/v1/sessions').set(auth).send({ title: 'Wiki gen' })
  const sessionId = created.body.data.id as string
  cleanups.push(async () => { service.dispose(); await prisma.$disconnect() })
  return { prisma, owner, teammates, service, events, request, auth, sessionId, modelCalls,
    settle: async () => { let n = 0; while (n < executions.length) { const current = executions.slice(n); n = executions.length; await Promise.all(current) } } }
}

// 生命周期驱动脚本（kind=wiki-update teammate 的模型回放——真 openwiki 生命周期工具面）：
// begin → submit_plan → next_page → write_file（副本执行）→ submit_page（带 claims 证据）→
// finish（触发治理钩子）→ 收尾文本。
function wikiUpdateTaskScript(opts: {
  fake: ReturnType<typeof seededFake>
  /** write_file 落盘后的观察窗（副本执行断言：容器树未变） */
  onAfterWrite?: () => void
  /** finish 前回调（冲突用例在此改容器树） */
  beforeFinish?: () => void
}): Reply[] {
  return [
    toolCallAi('lc1', 'openwiki_begin', { mode: 'update' }),
    (messages) => toolCallAi('lc2', 'openwiki_submit_plan', {
      runId: findRunId(messages),
      pages: [{ path: 'openwiki/concepts/demo.md', title: 'Demo', purpose: 'demo page' }],
      deletePages: [],
    }),
    (messages) => toolCallAi('lc3', 'openwiki_next_page', { runId: findRunId(messages) }),
    toolCallAi('lc4', 'write_file', {
      file_path: '/wiki/concepts/demo.md',
      content: '---\ntype: concept\ntitle: Demo\ndescription: A demo page\ntags: [demo]\n---\n\n# Demo\n\nBody.\n',
    }),
    (messages) => {
      opts.onAfterWrite?.()
      return toolCallAi('lc5', 'openwiki_submit_page', {
        runId: findRunId(messages),
        jobId: findJobId(messages),
        claims: [{ statement: 'The demo page documents the demo module.', evidence: [{ resource: 'repo://sources/concepts/existing.md' }] }],
      })
    },
    (messages) => {
      opts.beforeFinish?.()
      return toolCallAi('lc6', 'openwiki_finish', { runId: findRunId(messages) })
    },
    new AIMessage({ content: 'Wiki update finished.' }),
  ]
}

describe('#790 wiki-update teammate 全链（S1 · 验收①③）', () => {
  it('(a) 派生→副本执行→finish 推回：容器树收到 openwiki/** 子树内容（无 .git 条目），run completed', async () => {
    const fake = seededFake()
    let containerHadPageDuringRun: boolean | undefined
    const h = await harness({
      leader: [
        toolCallAi('spawn', 'spawn_teammate', { name: 'wiki-bot', task: 'update the wiki', kind: 'wiki-update' }),
        new AIMessage({ content: 'Leader done' }),
      ],
      'update the wiki': wikiUpdateTaskScript({ fake, onAfterWrite: () => { containerHadPageDuringRun = fake.trees.get(WIKI)!.has('/wiki/concepts/demo.md') } }),
    }, fake)
    expect((await h.request.post(`/api/v1/sessions/${h.sessionId}/messages`).set(h.auth).set('Idempotency-Key', 'a'.repeat(32)).send({ content: 'leader' })).body.code).toBe(0)
    await h.settle()

    // kind 持久化 + 治理驱动提示进 teammate 图 system prompt（模型面可见）
    const teammate = (await h.teammates.list(h.sessionId))[0]!
    expect(teammate.kind).toBe('wiki-update')
    expect(h.modelCalls.filter((call) => call.task === 'update the wiki').length).toBeGreaterThan(0)
    expect(h.modelCalls.filter((call) => call.task === 'update the wiki').every((call) => call.system.includes('wiki-update teammate'))).toBe(true)

    // 副本执行观察：write_file 落盘时容器树还没有该页（写面 = 治理副本，非直打容器）
    expect(containerHadPageDuringRun).toBe(false)

    // finish 推回：容器树收到生成页 + claims 旁车 + durable 元数据；无 .git 条目
    const keys = [...fake.trees.get(WIKI)!.keys()]
    expect(keys).toContain('/wiki/concepts/demo.md')
    expect(keys).toContain('/wiki/.claims/concepts/demo.json')
    expect(keys).toContain('/wiki/.last-update.json')
    expect(keys.some((k) => k.includes('.git'))).toBe(false)

    // run 终态：teammate completed；成功路径零冲突邮件
    expect(h.service.stateOf(teammate.threadId)?.state).toBe('completed')
    expect((await h.teammates.list(h.sessionId))[0]!.status).toBe('completed')
    expect((await h.teammates.mailboxHistory(h.sessionId)).map((m) => m.kind)).not.toContain('wiki-conflict')
  }, 90_000)

  it('(b) 冲突中止：finish 前 container 被轻写 → conflict Result、容器树保持改后状态、leader 收 wiki-conflict 邮件', async () => {
    const fake = seededFake()
    const h = await harness({
      leader: [
        toolCallAi('spawn', 'spawn_teammate', { name: 'wiki-bot', task: 'update the wiki', kind: 'wiki-update' }),
        new AIMessage({ content: 'Leader done' }),
      ],
      'update the wiki': wikiUpdateTaskScript({
        fake,
        beforeFinish: () => {
          // 模拟轻写通道并发写：治理 run 期间容器树被他人改动
          fake.trees.get(WIKI)!.set('/wiki/concepts/lightwrite.md', enc('# concurrent light write\n'))
        },
      }),
    }, fake)
    expect((await h.request.post(`/api/v1/sessions/${h.sessionId}/messages`).set(h.auth).set('Idempotency-Key', 'a'.repeat(32)).send({ content: 'leader' })).body.code).toBe(0)
    await h.settle()

    const teammate = (await h.teammates.list(h.sessionId))[0]!
    expect(h.service.stateOf(teammate.threadId)?.state).toBe('completed')

    // 推回未发生：容器树保持「轻写后」状态（无生成页），轻写内容未被覆盖
    const keys = [...fake.trees.get(WIKI)!.keys()]
    expect(keys).not.toContain('/wiki/concepts/demo.md')
    expect(keys).toContain('/wiki/concepts/lightwrite.md')

    // leader 信箱收到冲突邮件（不静默覆盖的用户可见面）
    const mail = (await h.teammates.mailboxHistory(h.sessionId)).find((m) => m.kind === 'wiki-conflict')
    expect(mail).toBeDefined()
    expect(mail!.recipientTeammateId).toBeNull()
  }, 90_000)

  it('(c) 中断 = 作废不推回：teammate 停在 interrupt → leader close_teammate → aborted，容器树零变更', async () => {
    const fake = seededFake()
    const before = [...fake.trees.get(WIKI)!.keys()].sort()
    let h!: Awaited<ReturnType<typeof harness>>
    h = await harness({
      leader: [
        toolCallAi('spawn', 'spawn_teammate', { name: 'wiki-bot', task: 'update the wiki', kind: 'wiki-update' }),
        async () => {
          await waitFor(async () => (await h.teammates.list(h.sessionId))[0]?.status === 'waiting')
          return toolCallAi('close', 'close_teammate', { name: 'wiki-bot' })
        },
        new AIMessage({ content: 'Leader done' }),
      ],
      // teammate 停在 mailbox interrupt——run 停车（finally dispose 镜像），无 finish = 无推回
      'update the wiki': [toolCallAi('wait', 'wait_for_teammate_mail', { timeoutMs: 5000 })],
    }, fake)
    expect((await h.request.post(`/api/v1/sessions/${h.sessionId}/messages`).set(h.auth).set('Idempotency-Key', 'a'.repeat(32)).send({ content: 'leader' })).body.code).toBe(0)
    await h.settle()

    const teammate = (await h.teammates.list(h.sessionId))[0]!
    expect(teammate.status).toBe('archived')
    expect(h.service.stateOf(teammate.threadId)?.state).toBe('aborted')
    expect(h.events.find((e) => e.type === 'run.aborted' && e.teammateId === teammate.id)).toMatchObject({ payload: { by: 'system' } })

    // 容器树零变更（中断 = 作废不推回；镜像已随 run 停车 dispose，无残留副作用面）
    const after = [...fake.trees.get(WIKI)!.keys()].sort()
    expect(after).toEqual(before)
    expect(after).not.toContain('/wiki/concepts/demo.md')
    expect((await h.teammates.mailboxHistory(h.sessionId)).map((m) => m.kind)).not.toContain('wiki-conflict')
  }, 90_000)
})
