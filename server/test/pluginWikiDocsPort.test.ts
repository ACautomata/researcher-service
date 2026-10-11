// #908 S1：ctx.wiki / ctx.docs 经 plugin run frame 注入插件工具（agent 面 ALS + {execute}
// 直达面显式构造，buildPluginRunFrame 单点）——外部行为断言（零新缝，沿 #873 已确认缝）：
//   1. execute 收到 ctx.wiki/ctx.docs（frame 面恒在）
//   2. createPage 端到端落 fake wiki 容器树：frontmatter source = 调用插件 id 盖章、
//      toolCallId = 真实 tool_call_id（agent 面 journal ALS / 直达面 figcmd-<runId> 派生）
//   3. search/read 读面与 extractPdfText 窄域口经 run 装配可用
// harness 对齐 figureRun.test.ts（ScriptedChatModel 触发工具调用 + fakePrimitives 双容器树）。

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

const WIKI = 'researcher-wiki-wd'
const LAB = 'researcher-sandbox-wd'

const captured: Array<{ toolCallId: string; hasWiki: boolean; hasDocs: boolean; probe: string }> = []

// fixture：research-like 插件（run.kind='research'——与未来真插件同源，source 盖章断言真实）。
// execute 按 params.mode 分派四路：create / search / read / pdf，port 观察值落 captured。
const wikidocsLike = definePlugin({
  id: 'research',
  name: 'RkWD',
  description: 'wiki/docs port fixture',
  version: '1.0.0',
  run: { kind: 'research' },
  tools: [
    {
      name: 'rkwd_probe',
      description: 'probe ctx.wiki/ctx.docs',
      category: 'domain',
      parameters: z.object({
        mode: z.enum(['create', 'search', 'read', 'pdf']),
        path: z.string().optional(),
      }),
      progressStages: ['capture'],
      execute: async (toolCallId, params: { mode: string; path?: string }, exec): Promise<PluginToolResult> => {
        const ctx = exec.ctx
        if (!ctx.wiki || !ctx.docs) throw new Error('ctx.wiki/ctx.docs 缺失')
        let probe: string
        if (params.mode === 'create') {
          const r = await ctx.wiki.createPage(
            { path: params.path ?? 'papers/x.md', title: 'X', type: 'paper', content: '# X\n\n正文。' },
            { workflow: 'ingest' },
          )
          probe = `created=${r.created}`
        } else if (params.mode === 'search') {
          const r = await ctx.wiki.search('attention 机制')
          probe = `hits=${r.results.length}`
        } else if (params.mode === 'read') {
          const r = await ctx.wiki.readPage('openwiki/concepts/attention.md', ['attention'])
          probe = `sections=${r.sections.length}`
        } else {
          const r = await ctx.docs.extractPdfText({ sandboxPath: params.path ?? '/lab/a.pdf' })
          probe = `pages=${r.pages.length}`
        }
        captured.push({ toolCallId, hasWiki: true, hasDocs: true, probe })
        return { content: [{ type: 'text', text: probe }] }
      },
    },
  ],
  commands: [
    { name: 'rkwd', handler: async () => ({ execute: { tool: 'rkwd_probe', args: { mode: 'create' } } }) },
  ],
})

type ScriptEntry = ConstructorParameters<typeof ScriptedChatModel>[0]

describe('#908 ctx.wiki/ctx.docs 经 run frame 注入（S1）', () => {
  let prisma: PrismaClient
  let owner: { id: string; username: string }
  let svc: RunService
  let dir: string
  let mem: ReturnType<typeof fakePrimitives>
  const scriptRef: { current: ScriptEntry } = { current: [] }

  function cmd(p: Partial<RunCommand>): RunCommand {
    return {
      runId: `run-${Math.random().toString(36).slice(2, 10)}`,
      sessionId: 'sess-wd-1',
      ownerId: owner.id,
      username: owner.username,
      kind: 'message',
      content: '',
      ...p,
    }
  }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'wikidocs-run-'))
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma, 'wikidocs-run-user', 'pw-wikidocs-run-secure')
    owner = { id: user.id, username: user.username }
    await prisma.session.create({ data: { id: 'sess-wd-1', ownerId: user.id, containerId: LAB, title: '' } })
    await prisma.modelProvider.create({
      data: { ownerId: user.id, providerId: 'prov-1', presetId: 'openai', modelsJson: JSON.stringify([{ id: 'm-1' }]) },
    })
    await assertValidPluginCatalog({
      manifests: [wikidocsLike],
      coreToolNames: ['task', 'read_official_skill'],
      reservedCommandNames: ['new', 'compact', 'model'],
    })
    mem = fakePrimitives()
    // 种子：wiki 容器一页（检索/read 面）+ 沙箱容器（docs 面走默认 fake exec）
    mem.trees.set(
      WIKI,
      new Map<string, Buffer | 'dir'>([
        ['/wiki', 'dir'],
        ['/wiki/concepts', 'dir'],
        ['/wiki/concepts/attention.md', Buffer.from('---\ntitle: Attention\n---\n# Attention\n\nScaled dot-product attention 机制。\n')],
      ]),
    )
    mem.trees.set(LAB, new Map<string, Buffer | 'dir'>([['/lab', 'dir']]))
    const registry = new ProviderRegistry(prisma, {
      llmApiKey: 'test-key',
      modelFactory: async () => new ScriptedChatModel(scriptRef.current),
    })
    svc = new RunService({
      prisma,
      registry,
      saver: new PrismaCheckpointSaver(prisma),
      gate: new ConcurrencyGate({ globalLimit: 8, loadUserLimit: async () => 4 }),
      hub: new CollectingHub(),
      primitives: mem.primitives,
      resolveWikiContainer: () => WIKI,
      sweepIntervalMs: 0,
      plugins: createPluginRuntime({ manifests: [...PLUGIN_MANIFESTS, wikidocsLike], config: {} }),
    })
    await prisma.pluginEnablement.create({ data: { ownerId: user.id, pluginId: 'research', enabled: true, enabledAt: new Date() } })
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  // ProviderRegistry 模型缓存跨 run 存续（modelCache，生产稳态语义）——每轮 bump 配置版本
  // 走真实热生效路径清缓存重建模型（scriptRef 换新脚本；图缓存键含版本，同重建）。
  let version = 1
  async function setScript(entries: ScriptEntry) {
    version += 1
    await prisma.configMeta.upsert({ where: { id: 1 }, create: { id: 1, version }, update: { version } })
    scriptRef.current = entries
  }

  it('agent 面：ALS frame 注入 ctx.wiki/ctx.docs；createPage 落树且 source=research、toolCallId=真实 tool_call_id', async () => {
    captured.length = 0
    await setScript([
      toolCallAi('wd-1', 'rkwd_probe', { mode: 'create', path: 'papers/agent.md' }),
      new AIMessage({ content: 'done' }),
    ])
    await svc.execute(cmd({ content: '跑一下' }))
    expect(captured).toEqual([{ toolCallId: 'wd-1', hasWiki: true, hasDocs: true, probe: 'created=true' }])
    const stored = mem.trees.get(WIKI)?.get('/wiki/papers/agent.md')
    expect(stored).toBeDefined()
    const md = stored!.toString('utf8')
    expect(md).toContain('source: "research"')
    expect(md).toContain('generated: {by: "research"')
    expect(md).toContain('toolCallId: "wd-1"')
    expect(md).toContain('workflow: "ingest"')
  })

  it('agent 面：search/read 读面通（与主 agent 同检索通道）', async () => {
    captured.length = 0
    await setScript([
      toolCallAi('wd-2', 'rkwd_probe', { mode: 'search' }),
      toolCallAi('wd-3', 'rkwd_probe', { mode: 'read' }),
      new AIMessage({ content: 'done' }),
    ])
    await svc.execute(cmd({ content: '检索' }))
    expect(captured.map((c) => c.probe)).toEqual(['hits=1', 'sections=1'])
  })

  it('agent 面：extractPdfText 窄域口通（沙箱容器 = run 的 labContainer）', async () => {
    captured.length = 0
    await setScript([
      toolCallAi('wd-4', 'rkwd_probe', { mode: 'pdf', path: '/lab/p.pdf' }),
      new AIMessage({ content: 'done' }),
    ])
    await svc.execute(cmd({ content: '提取' }))
    expect(captured.map((c) => c.probe)).toEqual(['pages=1'])
  })

  it('直达面：{execute} 显式构造同 frame——ctx 双口在、toolCallId=figcmd-<runId> 落 frontmatter', async () => {
    captured.length = 0
    const c = cmd({ operation: 'plugin-execute', pluginTool: 'rkwd_probe', pluginArgs: { mode: 'create', path: 'papers/direct.md' } })
    await svc.execute(c)
    expect(captured.length).toBe(1)
    expect(captured[0]!.hasWiki).toBe(true)
    expect(captured[0]!.hasDocs).toBe(true)
    const md = mem.trees.get(WIKI)?.get('/wiki/papers/direct.md')?.toString('utf8')
    expect(md).toContain(`toolCallId: "figcmd-${c.runId}"`)
    expect(md).toContain('source: "research"')
  })
})
