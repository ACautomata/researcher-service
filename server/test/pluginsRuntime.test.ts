// #788 S1/S2：插件启用集过滤 × 图装配 × 漏斗同闸门路由——RunService + 插件运行时 +
// fixture 插件（domain/file 两类别）+ fake judge/原语 + 临时 SQLite。验收面：
//   - 启用集 per-run 快照：禁用 = 工具与 promptSnippet 均不进图（§4.2 静态过滤）
//   - domain 类插件工具短路漏斗（零 judge 零审批审计行，§3）
//   - file 类插件工具按声明 pathParams 过同一路径白名单（白名单外同闸门升级）
//   - details 经 artifact 通道落 tool.end（R5 双面）
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { PrismaCheckpointSaver } from '../src/runner/persistence/prismaCheckpointSaver'
import { ProviderRegistry } from '../src/runner/providerRegistry'
import { ConcurrencyGate } from '../src/runner/concurrency'
import { RunService, type RunCommand } from '../src/runner/runtime/runService'
import { ApprovalFunnel } from '../src/runner/approval/funnel'
import { createPrismaApprovalAuditSink } from '../src/runner/approval/audit'
import { seedUser } from './helpers'
import { ScriptedChatModel, fakePrimitives, CollectingHub, toolCallAi, type ScriptEntry } from './runnerFakes'
import { definePlugin, type AnyPluginToolDefinition } from '../src/plugins/api'
import { createPluginRuntime } from '../src/plugins/surface'

const WIKI = 'researcher-wiki-pg'
const LAB = 'researcher-sandbox-pg'

// fixture 插件：domain 类 echo（带 details artifact）+ file 类 lab 读（声明 pathParams）。
const execCalls: Array<{ name: string; params: unknown }> = []
let llmThreaded = false // fixture 工具执行时 ctx.llm 是否已被 frame 穿线（#883 AC 观测面）
function fixtureTool(name: string, overrides: Partial<AnyPluginToolDefinition>): AnyPluginToolDefinition {
  return {
    name,
    parameters: z.object({ input: z.string().optional(), target: z.string().optional() }),
    description: `${name} fixture`,
    category: 'domain',
    execute: async (_toolCallId, params) => {
      execCalls.push({ name, params })
      return { content: [{ type: 'text', text: `${name} ok` }] }
    },
    ...overrides,
  }
}
const fixtureManifest = definePlugin({
  id: 'fixture',
  name: 'Fixture',
  description: 'test fixture plugin',
  version: '1.0.0',
  tools: [
    fixtureTool('fixture_echo', {
      promptSnippet: 'echo input back for tests',
      execute: async (_toolCallId, params, exec) => {
        execCalls.push({ name: 'fixture_echo', params })
        llmThreaded = exec.ctx.llm !== undefined
        return {
          content: [{ type: 'text', text: `echo:${(params as { input?: string }).input ?? ''}` }],
          details: { echo: (params as { input?: string }).input ?? '' },
        }
      },
    }),
    fixtureTool('fixture_lab_read', {
      category: 'file',
      pathParams: ['target'],
      parameters: z.object({ target: z.string() }),
      execute: async (_toolCallId, params) => {
        execCalls.push({ name: 'fixture_lab_read', params })
        return { content: [{ type: 'text', text: `read:${(params as { target: string }).target}` }] }
      },
    }),
  ],
})

describe('#788 插件运行时（S1/S2，#752 §3/§4.2）', () => {
  let prisma: PrismaClient
  let hub: CollectingHub
  let owner: { id: string; username: string }
  const cleanupDirs: string[] = []


  const modelCalls: Array<{ task: string; system: string }> = []

  function makeService(script: ScriptEntry[]): RunService {
    const registry = new ProviderRegistry(prisma, {
      llmApiKey: 'test-key',
      modelFactory: async () => {
        const model = new ScriptedChatModel(script)
        model.callbacks = [{ name: 'FakeLLMTransport', handleChatModelStart: (_m, batches, _r, _p, _e, _t, metadata) => {
          const messages = batches[0] ?? []
          modelCalls.push({ task: '', system: JSON.stringify(messages.filter((m: BaseMessage) => m.getType() === 'system').map((m: BaseMessage) => m.content)), ...(metadata ?? {}) })
        } }]
        return model
      },
    })
    const pluginRuntime = createPluginRuntime({ manifests: [fixtureManifest], config: {} })
    const funnel = new ApprovalFunnel({
      // judge 未配置：灰区一律升级人工（fail-closed）——file 类白名单外的同闸门升级判据
      audit: createPrismaApprovalAuditSink(prisma),
      pluginToolSpecs: (name) => pluginRuntime.toolSpecByName.get(name),
    })
    return new RunService({
      prisma,
      registry,
      saver: new PrismaCheckpointSaver(prisma),
      gate: new ConcurrencyGate({ globalLimit: 8, loadUserLimit: async () => 4 }),
      hub,
      primitives: fakePrimitives().primitives,
      resolveWikiContainer: () => WIKI,
      approvals: funnel,
      sweepIntervalMs: 0,
      plugins: pluginRuntime,
    })
  }

  function cmd(sid: string, p: Partial<RunCommand> = {}): RunCommand {
    return {
      runId: `run-${Math.random().toString(36).slice(2, 10)}`,
      sessionId: sid,
      ownerId: owner.id,
      username: owner.username,
      kind: 'message',
      content: '跑一下插件工具',
      ...p,
    }
  }

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'plugins-runtime-'))
    cleanupDirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma, 'plugins-user', 'pw-plugins-secure')
    owner = { id: user.id, username: user.username }
    for (const sid of ['sess-pg-1', 'sess-pg-2', 'sess-pg-3', 'sess-pg-4']) {
      await prisma.session.create({ data: { id: sid, ownerId: user.id, containerId: LAB, title: '' } })
    }
    await prisma.modelProvider.create({
      data: {
        ownerId: user.id,
        providerId: 'prov-1',
        presetId: 'openai',
        modelsJson: JSON.stringify([{ id: 'm-1' }]),
      },
    })
    hub = new CollectingHub()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    for (const dir of cleanupDirs.splice(0)) {
      await import('node:fs').then((fs) => fs.rmSync(dir, { recursive: true, force: true }))
    }
  })

  it('禁用态：插件工具与 promptSnippet 均不进图（§4.2 静态过滤）', async () => {
    execCalls.length = 0
    const svc = makeService([new AIMessage({ content: 'ok' })])
    await svc.execute(cmd('sess-pg-1'))
    expect(hub.types()[hub.types().length - 1]).toBe('run.completed')
    expect(modelCalls.at(-1)!.system).not.toContain('Enabled plugin tools')
    expect(execCalls).toHaveLength(0)
  })

  it('启用态：domain 类插件工具短路漏斗执行，details 走 artifact 通道进 tool.end', async () => {
    execCalls.length = 0
    await prisma.pluginEnablement.create({ data: { ownerId: owner.id, pluginId: 'fixture', enabled: true, enabledAt: new Date() } })
    const svc = makeService([
      toolCallAi('c1', 'fixture_echo', { input: 'hi' }),
      new AIMessage({ content: 'done' }),
    ])
    await svc.execute(cmd('sess-pg-2'))
    expect(hub.types()[hub.types().length - 1]).toBe('run.completed')
    expect(execCalls).toEqual([{ name: 'fixture_echo', params: { input: 'hi' } }])
    // ctx.llm 穿线（#883 AC）：agent 自动调用路径 frame.llmFor(工具名→插件 id) 注入
    expect(llmThreaded).toBe(true)
    expect(modelCalls.at(-1)!.system).toContain('Enabled plugin tools')
    expect(modelCalls.at(-1)!.system).toContain('fixture_echo: echo input back for tests')
    const end = hub.events.find((e) => e.type === 'tool.end')
    expect(end).toBeDefined()
    expect(end!.payload).toMatchObject({ toolCallId: 'c1', name: 'fixture_echo', state: 'success' })
    expect(JSON.parse((end!.payload as { details: string }).details)).toEqual({ echo: 'hi' })
    // domain 不进漏斗：零审批审计行（§3 路由表）
    const auditRow = await prisma.toolApprovalLog.findFirst({ where: { toolName: 'fixture_echo' } })
    expect(auditRow).toBeNull()
  })

  it('file 类插件工具按声明 pathParams 过同一路径白名单——命中放行 + 规则层审计行', async () => {
    execCalls.length = 0
    const svc = makeService([
      toolCallAi('c2', 'fixture_lab_read', { target: 'lab/notes/a.txt' }),
      new AIMessage({ content: 'done' }),
    ])
    await svc.execute(cmd('sess-pg-3'))
    expect(hub.types()[hub.types().length - 1]).toBe('run.completed')
    expect(execCalls.at(-1)).toEqual({ name: 'fixture_lab_read', params: { target: 'lab/notes/a.txt' } })
    const row = await prisma.toolApprovalLog.findFirst({ where: { toolName: 'fixture_lab_read', layer: 'rule' } })
    expect(row).toMatchObject({ decision: 'allow', reason: 'path_whitelist', userId: owner.id })
  })

  it('file 类插件工具白名单外走同闸门升级（judge 未配置 fail-closed → 审批 interrupt）', async () => {
    execCalls.length = 0
    const svc = makeService([
      toolCallAi('c3', 'fixture_lab_read', { target: 'etc/passwd' }),
    ])
    await svc.execute(cmd('sess-pg-4'))
    expect(hub.types()[hub.types().length - 1]).toBe('approval.requested')
    const requested = hub.events.find((e) => e.type === 'approval.requested')
    expect(requested).toBeDefined()
    expect((requested!.payload as { escalation: { toolName: string } }).escalation.toolName).toBe('fixture_lab_read')
    expect(execCalls.at(-1)?.name).not.toBe('fixture_lab_read')
    expect(await svc.stateOf('sess-pg-4')).toMatchObject({ state: 'interrupted' })
  })
})
