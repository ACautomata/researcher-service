// #790 通道③ S1 信封级集成：POST /api/v1/wiki/update 独立 run（验收②③；#856 起 owner 级
// 路径，零容器行查询）。
// 真 SQLite + 真 StreamHub + 真 openwiki runNativeRepositoryGeneration（deep-import 契约面）+
// 真 WikiUpdateRunService——只假 LLM/Docker（teammateRuntime.test.ts harness 先例）。
//
// 验收面：
//   (a) POST → 200 信封 data.runId 即返 → hub 收到 wiki_run.progress（planning/generating/
//       finalizing）、text、tool_start/tool_end、finished{outcome:'completed'}，无 debug 事件；
//       完成后容器树 = 推回结果。
//   (b) 在飞期间二次 POST → 30042（全局串行起步的 REST 反馈面）。
//   (c) 冲突路径——run 期间改容器树（模拟轻写并发）→ finished{outcome:'conflict'}、容器树保持。
//   (d) 异常路径（modelFactory 抛）→ finished{outcome:'failed'}、不推回——独立 run 无用户中断面，
//       AC3「中断 = 作废」在此路径以异常/崩溃兑现（方案声明的验收口径）。

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
import { ProviderRegistry } from '../src/runner/providerRegistry'
import { WikiUpdateRunService } from '../src/wiki/updateRun'
import { wikiContainerName } from '../src/wikiContainers/runtime'
import {
  WIKI_RUN_FINISHED,
  WIKI_RUN_PROGRESS,
  WIKI_RUN_TEXT,
  WIKI_RUN_TOOL_END,
  WIKI_RUN_TOOL_START,
} from '../src/runner/wikigen/values'
import { fakePrimitives, ScriptedChatModel, toolCallAi } from './runnerFakes'
import { seedUser, waitFor } from './helpers'

const enc = (s: string) => Buffer.from(s, 'utf8')

type Reply = AIMessage | ((messages: BaseMessage[]) => Promise<AIMessage> | AIMessage)

// 真 openwiki native runner 的固定驱动输入（repository-runner.js 的 user message 原文）。
const PLANNER_INPUT = 'Plan this repository wiki now.'
const WORKER_INPUT = 'Research and document the assigned page, then submit it.'

class KeyedChatModel extends ScriptedChatModel {
  private positions = new Map<string, number>()
  constructor(private readonly replies: Record<string, Reply[]>) {
    super([])
  }
  override async _generate(messages: BaseMessage[]) {
    const input = messages.find((m) => m.getType() === 'human')?.content
    const key = typeof input === 'string' ? input : ''
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

// fake wiki 容器树（键 = wikiContainerName(owner.id)——路由按认证身份派生同名，wiki 容器寻址
// 与生产一致）
function seededFake(wiki: string) {
  const fake = fakePrimitives()
  fake.trees.set(
    wiki,
    new Map<string, Buffer | 'dir'>([
      ['/wiki', 'dir'],
      ['/wiki/concepts', 'dir'],
      ['/wiki/concepts/existing.md', enc('# Existing\n\nSeed page.\n')],
    ]),
  )
  return fake
}

async function harness(opts: {
  replies?: Record<string, Reply[]>
  modelFactoryThrows?: boolean
  /** worker 起步回调（冲突用例在此改容器树；h 由闭包回读） */
  onWorkerStart?: (fake: ReturnType<typeof seededFake>) => void
}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wikigen-api-'))
  const dbPath = path.join(dir, 'test.db')
  const sqlite = new Database(dbPath)
  sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma/init.sql'), 'utf8'))
  sqlite.close()
  const prisma = createPrismaClient(`file:${dbPath}`)
  const owner = await seedUser(prisma, 'wikigen-api-user', 'wikigen-api-password')
  const wiki = wikiContainerName(owner.id)
  const fake = seededFake(wiki)
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
  const onWorkerStartRef = opts.onWorkerStart
  const service = new WikiUpdateRunService({
    hub,
    primitives: fake.primitives,
    registry: new ProviderRegistry(prisma, {
      llmApiKey: 'fake',
      modelFactory: opts.modelFactoryThrows
        ? async () => { throw new Error('provider exploded') }
        : async () => new KeyedChatModel(withWorkerHook(opts.replies ?? {}, () => onWorkerStartRef?.(fake))),
    }),
  })
  const request = supertest(createApp({
    prisma,
    events: { hub },
    wiki: {
      wikiContainers: { ensure: async () => {} },
      updateRunner: { start: async (params) => service.start(params) },
    },
  }))
  const access = await signAccessToken(owner.id)
  const auth = { Authorization: `Bearer ${access}` }
  cleanups.push(async () => { await prisma.$disconnect() })
  return { owner, wiki, service, events, request, auth, fake,
    post: () => request.post('/api/v1/wiki/update').set(auth).send({}),
    waitForFinished: async () => {
      await waitFor(() => events.some((e) => e.type === WIKI_RUN_FINISHED), 90_000)
      return events.find((e) => e.type === WIKI_RUN_FINISHED)!
    },
  }
}

// worker 首轮回放前插入观察钩子（冲突用例的容器树轻写时机）
function withWorkerHook(replies: Record<string, Reply[]>, hook: () => void): Record<string, Reply[]> {
  const worker = [...(replies[WORKER_INPUT] ?? [])]
  return {
    ...replies,
    [WORKER_INPUT]: [
      // 替换（非前插）首条 worker 回复——重复的 write 调用同 id 会炸 pregel 任务
      async (messages) => {
        hook()
        const first = worker[0]
        if (!first) throw new Error('no worker reply')
        return typeof first === 'function' ? await first(messages) : first
      },
      ...worker.slice(1),
    ],
  }
}

// 生命周期驱动脚本（真 openwiki native runner 的模型回放）：planner 一页计划；worker 写页 +
// submit_page（带 claims 证据——evidence 指向镜像 sources/ 语料副本）。
function generationReplies(): Record<string, Reply[]> {
  return {
    [PLANNER_INPUT]: [
      toolCallAi('p1', 'submit_plan', {
        pages: [{ path: 'openwiki/concepts/demo.md', title: 'Demo', purpose: 'demo page' }],
        deletePages: [],
      }),
      new AIMessage({ content: 'Plan submitted.' }),
    ],
    [WORKER_INPUT]: [
      toolCallAi('w1', 'write_file', {
        file_path: '/openwiki/concepts/demo.md',
        content: '---\ntype: concept\ntitle: Demo\ndescription: A demo page\ntags: [demo]\n---\n\n# Demo\n\nBody.\n',
      }),
      // jobId 由 native runner 的 submit_page 闭包注入（{jobId: job.id, ...reconciliation}）——
      // 模型面只回传 sparse Claim decisions（repository-runner.js runPageAgent 同形态）
      toolCallAi('w2', 'submit_page', {
        claims: [{ statement: 'The demo page documents the demo module.', evidence: [{ resource: 'repo://sources/concepts/existing.md' }] }],
      }),
      new AIMessage({ content: 'Page submitted.' }),
    ],
  }
}

describe('#790 wiki 全量更新独立 run（S1 · 验收②③）', () => {
  it('(a) POST 即返 runId → 五类 wiki_run 事件流（无 debug）→ finished completed → 容器树 = 推回结果', async () => {
    const h = await harness({ replies: generationReplies() })
    const response = await h.post()
    expect(response.status).toBe(200)
    expect(response.body.code).toBe(0)
    const runId = response.body.data.runId as string
    expect(runId).toBeTruthy()

    const finished = await h.waitForFinished()
    expect(finished.runId).toBe(runId)
    expect(finished.payload).toEqual({ outcome: 'completed' })

    // 五类事件序列：progress 三阶段 + text + tool_start/tool_end；runId 全盖印；无 debug
    const types = h.events.filter((e) => e.runId === runId).map((e) => e.type)
    expect(types[0]).toBe(WIKI_RUN_PROGRESS)
    expect(types).toContain(WIKI_RUN_TEXT)
    expect(types).toContain(WIKI_RUN_TOOL_START)
    expect(types).toContain(WIKI_RUN_TOOL_END)
    const stages = h.events
      .filter((e) => e.type === WIKI_RUN_PROGRESS)
      .map((e) => (e.payload as { stage: string }).stage)
    expect(stages).toEqual(['planning', 'generating', 'finalizing'])
    const generating = h.events.find((e) => e.type === WIKI_RUN_PROGRESS && (e.payload as { stage: string }).stage === 'generating')!
    expect(generating.payload).toMatchObject({ page: '/openwiki/concepts/demo.md', pageCount: 1 })
    expect(h.events.some((e) => (e.payload as { stage?: string }).stage === 'debug' || e.type.includes('debug'))).toBe(false)

    // 事件即焚面（独立 run 无 sessionId 行——runId 即关联键）
    expect(h.events.every((e) => e.sessionId === undefined)).toBe(true)

    // 容器树终态 = 推回结果（生成页 + claims 旁车 + durable 元数据；无 .git）
    const keys = [...h.fake.trees.get(h.wiki)!.keys()]
    expect(keys).toContain('/wiki/concepts/demo.md')
    expect(keys).toContain('/wiki/.claims/concepts/demo.json')
    expect(keys).toContain('/wiki/.last-update.json')
    expect(keys.some((k) => k.includes('.git'))).toBe(false)
    // 在飞观测面回落
    expect(h.service.activeRunId).toBeNull()
  }, 120_000)

  it('(b) 在飞期间二次 POST → 30042（WIKI_UPDATE_IN_PROGRESS）', async () => {
    let release!: () => void
    const latch = new Promise<void>((r) => { release = r })
    const replies = generationReplies()
    const worker = [...(replies[WORKER_INPUT] as Reply[])]
    replies[WORKER_INPUT] = [async (): Promise<AIMessage> => { await latch; const first = worker[0]!; return typeof first === 'function' ? (await first([])) : first }, ...worker.slice(1)]
    const h = await harness({ replies })
    const first = await h.post()
    expect(first.body.code).toBe(0)
    // 在飞观测面已同步置位（start 同步预检的依据）
    await waitFor(() => h.service.activeRunId !== null, 5_000)
    const second = await h.post()
    expect(second.body.code).toBe(30042)
    release()
    const finished = await h.waitForFinished()
    expect(finished.payload).toEqual({ outcome: 'completed' })
  }, 120_000)

  it('(c) 冲突路径：run 期间容器树被轻写 → finished conflict、容器树保持轻写后状态', async () => {
    let h!: Awaited<ReturnType<typeof harness>>
    h = await harness({
      replies: generationReplies(),
      onWorkerStart: (fake) => {
        // 模拟轻写通道并发写：治理 run 期间容器树被他人改动
        fake.trees.get(h.wiki)!.set('/wiki/concepts/lightwrite.md', enc('# concurrent light write\n'))
      },
    })
    expect((await h.post()).body.code).toBe(0)
    const finished = await h.waitForFinished()
    expect(finished.payload).toEqual({ outcome: 'conflict' })
    // 推回未发生：容器树保持「轻写后」状态（无生成页、无 .last-update.json 元数据）
    const keys = [...h.fake.trees.get(h.wiki)!.keys()]
    expect(keys).not.toContain('/wiki/concepts/demo.md')
    expect(keys).toContain('/wiki/concepts/lightwrite.md')
    expect(h.service.activeRunId).toBeNull()
  }, 120_000)

  it('(d) 异常路径：modelFactory 抛 → finished failed、不推回（AC3「中断=作废」的独立 run 兑现面）', async () => {
    const h = await harness({ modelFactoryThrows: true })
    const response = await h.post()
    expect(response.body.code).toBe(0) // 触发面即返，失败只在事件面与镜像生命周期内消化
    const finished = await h.waitForFinished()
    expect(finished.payload).toEqual({ outcome: 'failed' })
    // 不推回：容器树零变更（也无生成期事件——故障发生在生成起步前）
    const after = [...h.fake.trees.get(h.wiki)!.keys()].sort()
    expect(after).toEqual(['/wiki', '/wiki/concepts', '/wiki/concepts/existing.md'])
    expect(h.events.filter((e) => e.type === WIKI_RUN_PROGRESS)).toEqual([])
    expect(h.service.activeRunId).toBeNull()
  }, 120_000)
})
