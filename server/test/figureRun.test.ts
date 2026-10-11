// #792 S1：figure 工具两条触发面一条执行面（RunService 集成）——
//   直达面（{execute} → executePluginToolRun）：figure_run.progress SSE + tool.start/end
//   details + created/stage_transitions/completed TextTrace + zod 预校验；
//   agent 面（自动调用 → streamEvents）：ALS run frame 注入 ctx 四件、真实 tool_call_id
//   与 tool.start 同源（幂等去重身份 = 调用方 run 的 toolCallId）。
// fixture figure-like 插件形状对齐 autofigure execute 消费面（ctx 四件 + onUpdate stage）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { AIMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { PrismaCheckpointSaver } from '../src/runner/persistence/prismaCheckpointSaver'
import { ProviderRegistry } from '../src/runner/providerRegistry'
import { ConcurrencyGate } from '../src/runner/concurrency'
import { RunService, type RunCommand } from '../src/runner/runtime/runService'
import { seedUser } from './helpers'
import { ScriptedChatModel, fakePrimitives, CollectingHub, toolCallAi } from './runnerFakes'
import { definePlugin, type PluginToolResult } from '../src/plugins/api'
import { createPluginRuntime } from '../src/plugins/surface'
import { PLUGIN_MANIFESTS } from '../../plugins/index'
import { assertValidPluginCatalog } from '../src/plugins/registry'

const WIKI = 'researcher-wiki-pg'
const LAB = 'researcher-sandbox-pg'

// fixture：捕获面（execute 收到的 ctx 与 toolCallId）+ stage 上报（含白名单外丢弃项）。
// #853 §3.2#6 声明迁移：figure-like 插件的 stage 白名单由 manifest progressStages 承载
// （run.kind='figure' → 事件名派生 figure_run.progress 零变）。
const captured: Array<{ toolCallId: string; run?: { ownerId: string; sessionId: string; runId: string } }> = []

const figureLike = definePlugin({
  id: 'figlike',
  name: 'FigLike',
  description: 'figure-like fixture',
  version: '1.0.0',
  run: { kind: 'figure' },
  tools: [
    {
      name: 'figlike_generate',
      description: 'generate a fixture figure',
      category: 'domain',
      parameters: z.object({ method_text: z.string().min(1) }),
      progressStages: ['generating', 'segmenting', 'rendering'],
      execute: async (toolCallId, params: { method_text: string }, exec): Promise<PluginToolResult<{ figureId: string; state: string; previewReady: boolean }>> => {
        const ctx = exec.ctx
        captured.push({ toolCallId, run: ctx.run ? { ...ctx.run } : undefined })
        ctx.audit!.emitPluginRun({ event: 'created', toolCallId, detail: { methodText: params.method_text } })
        exec.onUpdate?.({ stage: 'generating' })
        exec.onUpdate?.({ stage: 'segmenting' })
        exec.onUpdate?.({ stage: 'bogus' }) // 白名单外——runner 面丢弃
        const { figureId } = await ctx.figures!.create({ prompt: params.method_text, svg: '<svg/>', meta: { v: 1 }, sessionId: ctx.run!.sessionId })
        ctx.audit!.emitPluginRun({ event: 'completed', toolCallId, detail: { figureId } })
        return {
          content: [{ type: 'text', text: `figureId=${figureId} state=completed previewReady=false` }],
          details: { figureId, state: 'completed', previewReady: false },
        }
      },
    },
  ],
  commands: [
    { name: 'fl', handler: async () => ({ execute: { tool: 'figlike_generate', args: { method_text: '示意' } } }) },
  ],
})

// fixture：research-like 插件（#853 §3.2#6 泛化验收）——独立 progressStages + run.kind，
// 同一 run 内与 figure-like 共存：事件族名按声明派生互不串扰、runKind 反查盖章、extra
// 域字段（workflow）透传 SSE 载荷。
const researchCaptured: string[] = []

const researchLike = definePlugin({
  id: 'rknow',
  name: 'RkNow',
  description: 'research-like fixture',
  version: '1.0.0',
  run: { kind: 'rknow' },
  tools: [
    {
      name: 'rknow_workflow',
      description: 'fixture research workflow',
      category: 'domain',
      parameters: z.object({ topic: z.string().min(1) }),
      progressStages: ['capture', 'contextPack', 'summary'],
      execute: async (toolCallId, params: { topic: string }, exec): Promise<PluginToolResult> => {
        researchCaptured.push(toolCallId)
        exec.onUpdate?.({ stage: 'capture', workflow: 'ingest' })
        exec.onUpdate?.({ stage: 'design' }) // rknow 白名单外（figure 族值）——丢弃
        exec.onUpdate?.({ stage: 'contextPack', workflow: 'ingest' })
        return { content: [{ type: 'text', text: `done:${params.topic}` }] }
      },
    },
  ],
})

describe('#792 figure 工具两条触发面一条执行面（S1）', () => {
  let prisma: PrismaClient
  let hub: CollectingHub
  let owner: { id: string; username: string }
  let svc: RunService
  let dir: string

  function cmd(p: Partial<RunCommand>): RunCommand {
    return {
      runId: `run-${Math.random().toString(36).slice(2, 10)}`,
      sessionId: 'sess-fr-1',
      ownerId: owner.id,
      username: owner.username,
      kind: 'message',
      content: '',
      ...p,
    }
  }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'figure-run-'))
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma, 'figure-run-user', 'pw-figure-run-secure')
    owner = { id: user.id, username: user.username }
    await prisma.session.create({ data: { id: 'sess-fr-1', ownerId: user.id, containerId: LAB, title: '' } })
    await prisma.modelProvider.create({
      data: {
        ownerId: user.id,
        providerId: 'prov-1',
        presetId: 'openai',
        modelsJson: JSON.stringify([{ id: 'm-1' }]),
      },
    })
    hub = new CollectingHub()
    // 收录校验（fixtures 目录）：figlike 与真 autofigure 同族（run.kind='figure'）——run.kind
    // 目录唯一性校验（#853 事件族派生源不撞车）下 fixtures 不与 PLUGIN_MANIFESTS 混装校验；
    // autofigure 全目录收录校验由 app 装配面测试（setupTestApp）覆盖。runtime 面仍装全量
    //（翻译面查表含真插件无妨）。
    await assertValidPluginCatalog({
      manifests: [figureLike, researchLike],
      coreToolNames: ['task', 'read_official_skill'],
      reservedCommandNames: ['new', 'compact', 'model'],
    })
    const registry = new ProviderRegistry(prisma, {
      llmApiKey: 'test-key',
      modelFactory: async () => new ScriptedChatModel([
        toolCallAi('c1', 'figlike_generate', { method_text: '画示意图' }),
        new AIMessage({ content: 'done' }),
      ]),
    })
    svc = new RunService({
      prisma,
      registry,
      saver: new PrismaCheckpointSaver(prisma),
      gate: new ConcurrencyGate({ globalLimit: 8, loadUserLimit: async () => 4 }),
      hub,
      primitives: fakePrimitives().primitives,
      resolveWikiContainer: () => WIKI,
      sweepIntervalMs: 0,
      plugins: createPluginRuntime({ manifests: [...PLUGIN_MANIFESTS, figureLike, researchLike], config: {} }),
    })
    await prisma.pluginEnablement.create({ data: { ownerId: user.id, pluginId: 'figlike', enabled: true, enabledAt: new Date() } })
    await prisma.pluginEnablement.create({ data: { ownerId: user.id, pluginId: 'autofigure', enabled: true, enabledAt: new Date() } })
    await prisma.pluginEnablement.create({ data: { ownerId: user.id, pluginId: 'rknow', enabled: true, enabledAt: new Date() } })
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  it('直达面：figure_run.progress SSE（白名单外丢弃）+ tool.end details + turn 聚合', async () => {
    captured.length = 0
    hub.events.length = 0
    await svc.execute(cmd({ operation: 'plugin-execute', pluginTool: 'figlike_generate', pluginArgs: { method_text: '示意' } }))
    const types = hub.events.map((e) => e.type)
    expect(types[0]).toBe('run.started')
    expect(types).toContain('tool.start')
    // progress 两帧（bogus 丢弃）
    const progress = hub.events.filter((e) => e.type === 'figure_run.progress')
    expect(progress.map((e) => (e.payload as { stage: string }).stage)).toEqual(['generating', 'segmenting'])
    expect(progress.every((e) => e.sessionId === 'sess-fr-1' && typeof e.runId === 'string')).toBe(true)
    expect(progress.every((e) => typeof (e.payload as { toolCallId: string }).toolCallId === 'string')).toBe(true)
    // tool.end details = 引用形态
    const end = hub.events.find((e) => e.type === 'tool.end')
    expect((end!.payload as { state: string }).state).toBe('success')
    expect(JSON.parse((end!.payload as { details: string }).details)).toMatchObject({ figureId: expect.any(String), state: 'completed', previewReady: false })
    expect(types.at(-1)).toBe('run.completed')
  })

  it('直达面审计：created/stage_transitions×2/completed 落 TextTrace，runId 弱关联', async () => {
    const rows = await prisma.textTraceLog.findMany({ where: { runId: { not: null } }, orderBy: { id: 'asc' } })
    const events = rows.map((r) => (JSON.parse(r.outputText) as Record<string, unknown>).event as string)
    expect(events).toContain('created')
    expect(events.filter((e) => e === 'stage_transitions')).toHaveLength(2)
    expect(events).toContain('completed')
    const transitions = rows.filter((r) => (JSON.parse(r.outputText) as Record<string, unknown>).event === 'stage_transitions')
    const payloads = transitions.map((r) => JSON.parse(r.outputText) as Record<string, unknown>)
    expect(payloads.map((p) => p.to)).toEqual(['generating', 'segmenting'])
    // at 字段（#744 §11.2 stage_transitions{toolCallId,from?,to,at}）
    expect(payloads.every((p) => typeof p.at === 'number' && (p.at as number) > 0)).toBe(true)
    // created 的 inputText = methodText 截断
    const created = rows.find((r) => (JSON.parse(r.outputText) as Record<string, unknown>).event === 'created')!
    expect(created.inputText).toBe('示意')
  })

  it('直达面落库：figure 行 owner/sessionId 溯源正确；同 runId 重放（stalled 场景）单行不重复', async () => {
    const fig = await prisma.figure.findFirstOrThrow({ where: { prompt: '示意' } })
    expect(fig.ownerId).toBe(owner.id)
    expect(fig.sessionId).toBe('sess-fr-1')
    expect(fig.svg).toBe('<svg/>')
    expect(fig.evaluation).toBe(JSON.stringify({ v: 1 }))
    // toolCallId = figcmd-<runId> 确定性派生：同 job 重放 → 同 id → 去重表命中单行
    const before = await prisma.figure.count({ where: { prompt: '示意' } })
    await svc.execute(cmd({ runId: 'replay-run-1', operation: 'plugin-execute', pluginTool: 'figlike_generate', pluginArgs: { method_text: '重放示意' } }))
    await svc.execute(cmd({ runId: 'replay-run-1', operation: 'plugin-execute', pluginTool: 'figlike_generate', pluginArgs: { method_text: '重放示意' } }))
    expect(await prisma.figure.count({ where: { prompt: '重放示意' } })).toBe(1)
    expect(before).toBeGreaterThanOrEqual(1)
  })

  it('直达面输入 0 信任：pluginArgs 不过 zod → run failed（内核防御面，REST 前置层为 80001 即时反馈）', async () => {
    hub.events.length = 0
    await svc.execute(cmd({ operation: 'plugin-execute', pluginTool: 'figlike_generate', pluginArgs: { method_text: '' } }))
    expect(hub.events.map((e) => e.type).at(-1)).toBe('run.failed')
    expect(hub.events.some((e) => e.type === 'tool.start')).toBe(false)
    expect(await prisma.figure.count({ where: { prompt: '' } })).toBe(0)
  })

  it('agent 面：ALS run frame 注入 ctx 四件，execute toolCallId 与 tool.start 同源（真实 tool_call_id）', async () => {
    captured.length = 0
    hub.events.length = 0
    await svc.execute(cmd({ content: '画图' }))
    // ctx.run 身份注入（agent 路径 frame ALS）
    expect(captured).toHaveLength(1)
    expect(captured[0]!.run).toEqual({ ownerId: owner.id, sessionId: 'sess-fr-1', runId: expect.any(String) })
    // execute toolCallId = projector tool.start 的 tool_call_id（幂等去重身份同源）
    const start = hub.events.find((e) => e.type === 'tool.start')
    expect(captured[0]!.toolCallId).toBe((start!.payload as { toolCallId: string }).toolCallId)
    // agent 路径 progress 双面同样落 SSE
    const progress = hub.events.filter((e) => e.type === 'figure_run.progress')
    expect(progress.map((e) => (e.payload as { stage: string }).stage)).toEqual(['generating', 'segmenting'])
  })

  // ---------------- #853 §3.2#6 翻译面泛化 + §3.2#5 runKind 盖章 ----------------

  it('泛化翻译面：声明插件事件族按 run.kind 派生（rknow_run.progress），白名单跨插件独立，extra 域字段透传', async () => {
    researchCaptured.length = 0
    hub.events.length = 0
    await svc.execute(cmd({ operation: 'plugin-execute', pluginTool: 'rknow_workflow', pluginArgs: { topic: '蛋白质' } }))
    // 事件族名按声明派生；白名单命中 2 帧（design 是 figure 族值、rknow 白名单外 → 丢弃）
    const progress = hub.events.filter((e) => e.type === 'rknow_run.progress')
    expect(progress.map((e) => (e.payload as { stage: string }).stage)).toEqual(['capture', 'contextPack'])
    // extra 域字段（workflow）透传 SSE 载荷（#853 §6.1 research_run.progress {toolCallId, stage, workflow} 面）
    expect(progress.every((e) => (e.payload as { workflow?: string }).workflow === 'ingest')).toBe(true)
    // figure 族事件零串扰：rknow 的上报不进 figure_run.progress
    expect(hub.events.some((e) => e.type === 'figure_run.progress')).toBe(false)
    // TextTrace：stage_transitions×2 落 rknow 族，runKind 反查盖章 = 'rknow'
    const rows = await prisma.textTraceLog.findMany({ where: { sessionKey: 'sess-fr-1' }, orderBy: { id: 'desc' }, take: 10 })
    const transitions = rows.map((r) => JSON.parse(r.outputText) as Record<string, unknown>).filter((p) => p.event === 'stage_transitions' && p.runKind === 'rknow')
    expect(transitions).toHaveLength(2)
    expect(transitions.map((p) => p.to)).toEqual(['contextPack', 'capture']) // id desc 序
    // 双面完整（#853 §6.1「同一事实两面」）：extra 域字段（workflow）随审计面落载
    expect(transitions.every((p) => p.workflow === 'ingest')).toBe(true)
  })

  it('figure 事件面冻结：声明迁移后 stage_transitions 载荷无 runKind 列（零改动锁定）', async () => {
    captured.length = 0
    hub.events.length = 0
    await svc.execute(cmd({ operation: 'plugin-execute', pluginTool: 'figlike_generate', pluginArgs: { method_text: '冻结面' } }))
    const progress = hub.events.filter((e) => e.type === 'figure_run.progress')
    expect(progress.map((e) => (e.payload as { stage: string }).stage)).toEqual(['generating', 'segmenting'])
    const rows = await prisma.textTraceLog.findMany({ where: { sessionKey: 'sess-fr-1' }, orderBy: { id: 'desc' }, take: 10 })
    const transitions = rows
      .map((r) => JSON.parse(r.outputText) as Record<string, unknown>)
      .filter((p) => p.event === 'stage_transitions' && !('runKind' in p))
    expect(transitions.length).toBeGreaterThanOrEqual(2)
    // figure 族（kind 隐含 'figure'，#853 §3.2#5 迁移不做）——载荷无 runKind 列
    expect(transitions.every((p) => !('runKind' in p))).toBe(true)
  })
})
