// #788 S3/S1：命令两源合并（#752 §2.3 R4）+ 插件命令 {inject}/{execute} 运行时（R9）。
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import supertest from 'supertest'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { createPrismaClient } from '../src/prisma'
import { createApp } from '../src/app'
import { signAccessToken } from '../src/auth/tokens'
import { StreamHub } from '../src/events/hub'
import type { CatalogEvent } from '../src/events/logic'
import { RunService } from '../src/runner/runtime/runService'
import { ProviderRegistry } from '../src/runner/providerRegistry'
import { ConcurrencyGate } from '../src/runner/concurrency'
import { PrismaCheckpointSaver } from '../src/runner/persistence/prismaCheckpointSaver'
import { SessionService } from '../src/sessions/service'
import { mergeCommandDirectories } from '../src/plugins/commandResolution'
import { createPluginRuntime } from '../src/plugins/surface'
import { definePlugin, type AnyPluginToolDefinition } from '../src/plugins/api'
import { ScriptedChatModel } from './runnerFakes'
import { seedUser } from './helpers'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

describe('#788 命令两源合并（S3，#752 §2.3 R4）', () => {
  it('官方优先于插件（防御序）；未撞名插件命令入目录', () => {
    const dir = mergeCommandDirectories({
      official: [{ name: 'research', description: 'official template' }],
      plugin: [
        { manifestId: 'p', command: { name: 'research', handler: async () => ({ inject: 'x' }) } },
        { manifestId: 'p', command: { name: 'p-only', handler: async () => ({ inject: 'y' }) } },
      ],
    })
    expect(dir.get('research')).toMatchObject({ source: 'official' })
    expect(dir.get('p-only')).toMatchObject({ source: 'plugin' })
    expect(dir.get('p-only')).toMatchObject({ entry: expect.objectContaining({ manifestId: 'p' }) })
  })
})

// 捕获模型输入的脚本模型（inject/原文判别的观测面）
class CapturingModel extends ScriptedChatModel {
  readonly inputs: string[] = []
  override async _generate(messages: BaseMessage[]) {
    const input = messages.find(message => message.getType() === 'human')?.content
    this.inputs.push(typeof input === 'string' ? input : '')
    return { generations: [{ message: new AIMessage({ content: 'ack' }), text: 'ack' }] }
  }
}

describe('#788 插件命令运行时（S1，{inject}/{execute}）', () => {
  async function harness() {
    const dir = mkdtempSync(path.join(tmpdir(), 'plugins-cmd-'))
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma/init.sql'), 'utf8'))
    sqlite.close()
    const prisma = createPrismaClient(`file:${dbPath}`)
    const owner = await seedUser(prisma, 'plugins-cmd-user', 'plugins-cmd-password')
    await prisma.modelProvider.create({ data: {
      ownerId: owner.id, providerId: 'cmd-provider', presetId: 'openai',
      modelsJson: JSON.stringify([{ id: 'model-x' }]),
    } })
    const hub = new StreamHub()
    const events: CatalogEvent[] = []
    hub.register(owner.id, { send: frame => {
      const data = /^data: (.+)$/m.exec(frame)?.[1]
      if (data) events.push(JSON.parse(data) as CatalogEvent)
      return true
    }, close: () => {} })
    const gate = new ConcurrencyGate({ globalLimit: 4, loadUserLimit: async () => 4 })
    const model = new CapturingModel([])
    const service = new RunService({
      prisma, hub, gate, saver: new PrismaCheckpointSaver(prisma),
      registry: new ProviderRegistry(prisma, { llmApiKey: 'fake', modelFactory: async () => model }),
      primitives: (await import('./runnerFakes')).fakePrimitives().primitives,
      resolveWikiContainer: () => 'researcher-wiki-cmd',
      plugins: createPluginRuntime({ manifests: [fixtureManifest], config: {} }),
    })
    const executions: Promise<void>[] = []
    const dispatch = async (command: Parameters<RunService['execute']>[0]) => {
      const execution = service.execute(command)
      execution.catch(() => {})
      executions.push(execution)
    }
    const sessions = new SessionService({ prisma, hub, runService: service, dispatch, plugins: createPluginRuntime({ manifests: [fixtureManifest], config: {} }) })
    service.setRecordTurn(payload => sessions.recordTurn(payload))
    const request = supertest(createApp({ prisma, events: { hub }, sessions: { service: sessions } }))
    const access = await signAccessToken(owner.id)
    const auth = { Authorization: `Bearer ${access}` }
    const sessionId = (await request.post('/api/v1/sessions').set(auth).send({ title: 'cmd' })).body.data.id as string
    cleanups.push(async () => { service.dispose(); await prisma.$disconnect() })
    const settle = async () => { let n = 0; while (n < executions.length) { const current = executions.slice(n); n = executions.length; await Promise.all(current) } }
    const send = (content: string, key: string) => request.post(`/api/v1/sessions/${sessionId}/messages`).set(auth).set('Idempotency-Key', key).send({ content })
    return { prisma, owner, request, auth, sessionId, events, settle, send, model }
  }

  it('{inject}：handler 产出以 user message 注入，落行存原文', async () => {
    const h = await harness()
    await h.prisma.pluginEnablement.create({ data: { ownerId: h.owner.id, pluginId: 'fixture', enabled: true, enabledAt: new Date() } })
    expect((await h.send('/say hello world', 'a'.repeat(32))).body.code).toBe(0)
    await h.settle()
    expect(h.model.inputs).toEqual(['Say this: hello world'])
    const projection = (await h.request.get(`/api/v1/sessions/${h.sessionId}/messages`).set(h.auth)).body.data
    expect(projection.messages.map((m: { role: string; content: string }) => m.content)).toEqual(['/say hello world', 'ack'])
  }, 15_000)

  it('{execute}：直达插件工具执行面（零模型调用），标准 tool 事件 + 聚合入投影', async () => {
    const h = await harness()
    await h.prisma.pluginEnablement.create({ data: { ownerId: h.owner.id, pluginId: 'fixture', enabled: true, enabledAt: new Date() } })
    expect((await h.send('/echo-cmd hi there', 'b'.repeat(32))).body.code).toBe(0)
    await h.settle()
    expect(h.model.inputs).toEqual([])
    const end = h.events.find(event => event.type === 'tool.end')
    expect(end).toMatchObject({ sessionId: h.sessionId, payload: { name: 'fixture_echo', state: 'success' } })
    expect(JSON.parse((end!.payload as { details: string }).details)).toEqual({ echo: 'hi there' })
    const projection = (await h.request.get(`/api/v1/sessions/${h.sessionId}/messages`).set(h.auth)).body.data
    const assistant = projection.messages.at(-1) as { role: string; tools?: Array<{ name: string; state: string; details?: string }> }
    expect(assistant.role).toBe('assistant')
    expect(assistant.tools?.[0]).toMatchObject({ name: 'fixture_echo', state: 'success' })
  }, 15_000)

  it('禁用插件的命令按原文直入模型（无插件语义）', async () => {
    const h = await harness()
    expect((await h.send('/say not enabled', 'c'.repeat(32))).body.code).toBe(0)
    await h.settle()
    expect(h.model.inputs).toEqual(['/say not enabled'])
  }, 15_000)
})

// fixture 插件：{inject} 命令 + {execute} 命令（引用本插件 domain 工具）+ domain 工具本体。
const fixtureManifest = definePlugin({
  id: 'fixture',
  name: 'Fixture',
  description: 'command fixture plugin',
  version: '1.0.0',
  tools: [
    {
      name: 'fixture_echo',
      description: 'echo fixture tool',
      category: 'domain' as const,
      parameters: z.object({ input: z.string() }),
      execute: async (_toolCallId, params) => ({
        content: [{ type: 'text' as const, text: `echo:${(params as { input: string }).input}` }],
        details: { echo: (params as { input: string }).input },
      }),
    } as AnyPluginToolDefinition,
  ],
  commands: [
    { name: 'say', handler: async (args: string) => ({ inject: `Say this: ${args}` }) },
    { name: 'echo-cmd', handler: async (args: string) => ({ execute: { tool: 'fixture_echo', args: { input: args } } }) },
  ],
})
