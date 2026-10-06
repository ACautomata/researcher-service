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
const captured: Array<{ toolCallId: string; run?: { ownerId: string; sessionId: string; runId: string } }> = []

const figureLike = definePlugin({
  id: 'figlike',
  name: 'FigLike',
  description: 'figure-like fixture',
  version: '1.0.0',
  tools: [
    {
      name: 'figlike_generate',
      description: 'generate a fixture figure',
      category: 'domain',
      parameters: z.object({ method_text: z.string().min(1) }),
      execute: async (toolCallId, params: { method_text: string }, exec): Promise<PluginToolResult<{ figureId: string; state: string; previewReady: boolean }>> => {
        const ctx = exec.ctx
        captured.push({ toolCallId, run: ctx.run ? { ...ctx.run } : undefined })
        ctx.audit!.emitFigureRun({ event: 'created', toolCallId, detail: { methodText: params.method_text } })
        exec.onUpdate?.({ stage: 'generating' })
        exec.onUpdate?.({ stage: 'segmenting' })
        exec.onUpdate?.({ stage: 'bogus' }) // 白名单外——runner 面丢弃
        const { figureId } = await ctx.figures!.create({ prompt: params.method_text, svg: '<svg/>', meta: { v: 1 }, sessionId: ctx.run!.sessionId })
        ctx.audit!.emitFigureRun({ event: 'completed', toolCallId, detail: { figureId } })
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
        lcProvider: 'openai',
        baseUrl: 'https://llm.example.com/v1',
        credentialEnvId: 'LLM_API_KEY',
        authHeader: true,
        modelsJson: JSON.stringify([{ id: 'm-1' }]),
      },
    })
    await prisma.providerEndpoint.create({ data: { scheme: 'https', host: 'llm.example.com', port: null, createdBy: 'seed' } })
    hub = new CollectingHub()
    // 收录校验（目录含 autofigure + fixture——/figure 不撞系统保留名、figure_generate 不撞核心工具面）
    await assertValidPluginCatalog({
      manifests: [...PLUGIN_MANIFESTS, figureLike],
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
      plugins: createPluginRuntime({ manifests: [...PLUGIN_MANIFESTS, figureLike], config: {} }),
    })
    await prisma.pluginEnablement.create({ data: { ownerId: user.id, pluginId: 'figlike', enabled: true, enabledAt: new Date() } })
    await prisma.pluginEnablement.create({ data: { ownerId: user.id, pluginId: 'autofigure', enabled: true, enabledAt: new Date() } })
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
})
