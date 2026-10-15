// 推理强度生效语义（#979 实现票②）：图缓存 modelKey 并入 effort + fence 锁 + 在飞 run 快照。
// 接缝：buildLeaderAgent mock 捕获装配产物（model 绑定 bag）——图重建语义与 workflow fence
// 的行为级断言面；ctx.llm fence 用 createLlmToolPort 直接装配（registry fake factory 缝）。
//
// 锁定语义（ADR 0016 热生效同机制 · ADR 0019 决策 1）：
//   - 同 session 换档 → 下一 run 新图（旧图实例不受影响）；同档重复 run → 命中缓存。
//   - 在飞 run 持旧快照跑完：覆盖变更发生在 run 启动读行之后（executeRun 776 行读 session →
//     wikis.ensure 门 → 809 行才解析 preferred）——门内变更不影响本 run 绑定。
//   - fence：会话覆盖唯一消费点 = leader 图装配；ctx.llm 解析链（env pin > 指派 > 默认链）
//     覆盖变更前后逐字段不变（llmToolPort 结构性不读 session 行）。

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { AIMessage } from '@langchain/core/messages'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { PrismaCheckpointSaver } from '../src/runner/persistence/prismaCheckpointSaver'
import { ProviderRegistry, type ChatModelFactory } from '../src/runner/providerRegistry'
import { ConcurrencyGate } from '../src/runner/concurrency'
import { RunService, type RunCommand } from '../src/runner/runtime/runService'
import { createLlmToolPort } from '../src/runner/llmToolPort'
import { seedUser } from './helpers'
import { ScriptedChatModel, fakePrimitives, CollectingHub } from './runnerFakes'
import { installAbortRejectionGuard } from '../src/runner/runtime/abortGuard'

// buildLeaderAgent 捕获器（vi.mock 提升约束——计数器经 vi.hoisted 共享）
const builds = vi.hoisted(() => ({ captured: [] as Array<{ model: unknown }> }))
vi.mock('../src/runner/runtime/graphFactory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runner/runtime/graphFactory')>()
  return {
    ...actual,
    buildLeaderAgent: (params: Parameters<typeof actual.buildLeaderAgent>[0]) => {
      builds.captured.push({ model: params.model })
      return actual.buildLeaderAgent(params)
    },
  }
})

const WIKI = 'researcher-wiki-eff'
const LAB = 'researcher-sandbox-eff'
const COVERAGE = (modelId: string, effort: string): string =>
  JSON.stringify({ providerId: 'prov-eff', modelId, effort })

// withConfig 绑定 bag 读取（ScriptedChatModel 非 ConfigurableModel——withConfig 走 Runnable
// 基类 → RunnableBinding{bound, config}，config.configurable 即装配缝绑定面；多成员默认链
// 再经 withFallbacks 包装（RunnableWithFallbacks{runnable: primaryBound}）+ withChainBindTools
// Object.create 面不变——primary 绑定从 .runnable 挖出）。
function bindingOf(model: unknown): Record<string, unknown> | undefined {
  const m = model as { config?: { configurable?: Record<string, unknown> }; runnable?: { config?: { configurable?: Record<string, unknown> } } }
  return m.config?.configurable ?? m.runnable?.config?.configurable
}

describe('推理强度生效语义（#979）：图缓存失效 + fence 锁 + 在飞快照', () => {
  let prisma: PrismaClient
  let hub: CollectingHub
  let owner: { id: string; username: string }
  const sessionId = 'sess-eff'
  const cleanupDirs: string[] = []

  beforeAll(async () => {
    installAbortRejectionGuard()
    const dir = mkdtempSync(path.join(tmpdir(), 'runner-effort-'))
    cleanupDirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma, 'runner-effort', 'pw-runner-eff-secure')
    owner = { id: user.id, username: user.username }
    await prisma.session.create({
      data: { id: sessionId, ownerId: user.id, containerId: LAB, title: '' },
    })
    // deepseek 预设行（1:1 直传映射——绑定 bag 形状最直观）
    await prisma.modelProvider.create({
      data: {
        ownerId: user.id,
        providerId: 'prov-eff',
        presetId: 'deepseek',
        modelsJson: JSON.stringify([{ id: 'deepseek-v4-flash' }]),
      },
    })
    hub = new CollectingHub()
  }, 30_000)

  afterAll(async () => {
    await prisma.$disconnect()
  })

  afterEach(async () => {
    hub.reset()
    await prisma.session.update({ where: { id: sessionId }, data: { preferredModelJson: null } })
    await prisma.pluginLlmAssignment.deleteMany({ where: { ownerId: owner.id } })
  })

  function makeService(opts: { wikis?: { ensure: (ownerId: string) => Promise<void> } } = {}): RunService {
    const registry = new ProviderRegistry(prisma, {
      llmApiKey: 'test-key',
      // loop：同 provider 模型实例跨 run 缓存复用（registry 缓存 key 不含 model/effort），
      // 非循环脚本第二次 invoke 即耗尽——换档重建图路径必须可重复执行
      modelFactory: async () => new ScriptedChatModel([new AIMessage('ok')], { loop: true }),
    })
    return new RunService({
      prisma,
      registry,
      saver: new PrismaCheckpointSaver(prisma),
      gate: new ConcurrencyGate({ globalLimit: 8, loadUserLimit: async () => 4 }),
      hub,
      primitives: fakePrimitives().primitives,
      resolveWikiContainer: () => WIKI,
      ...(opts.wikis ? { wikis: opts.wikis } : {}),
      clock: (() => {
        let t = 0
        return () => (t += 10)
      })(),
    })
  }

  function cmd(): RunCommand {
    return {
      runId: `run-${Math.random().toString(36).slice(2, 10)}`,
      sessionId,
      ownerId: owner.id,
      username: owner.username,
      kind: 'message',
      content: 'hello',
    }
  }

  it('图缓存失效：同 session 换档 → 下一 run 新图（绑定随档）；同档重复 run 命中缓存', async () => {
    builds.captured.length = 0
    await prisma.session.update({ where: { id: sessionId }, data: { preferredModelJson: COVERAGE('deepseek-v4-flash', 'low') } })
    const svc = makeService()
    await svc.execute(cmd())
    expect(hub.types().at(-1)).toBe('run.completed')
    expect(builds.captured).toHaveLength(1)
    expect(bindingOf(builds.captured[0]!.model)).toEqual({
      model: 'deepseek-v4-flash',
      modelKwargs: { reasoning_effort: 'low' },
    })

    // 换档（low → max）：modelKey 并入 effort → 不命中旧图
    await prisma.session.update({ where: { id: sessionId }, data: { preferredModelJson: COVERAGE('deepseek-v4-flash', 'max') } })
    await svc.execute(cmd())
    expect(builds.captured).toHaveLength(2)
    expect(bindingOf(builds.captured[1]!.model)).toEqual({
      model: 'deepseek-v4-flash',
      modelKwargs: { reasoning_effort: 'max' },
    })
    // 旧图实例不受换档影响（在飞/缓存语义——旧绑定原样保留）
    expect(bindingOf(builds.captured[0]!.model)).toEqual({
      model: 'deepseek-v4-flash',
      modelKwargs: { reasoning_effort: 'low' },
    })

    // 同档重复 run：命中缓存（零新构建）
    await svc.execute(cmd())
    expect(builds.captured).toHaveLength(2)
  })

  it('在飞 run 持旧快照跑完：覆盖变更落在启动读行之后 → 本 run 绑定不随写翻转（ADR 0016 同机制）', async () => {
    builds.captured.length = 0
    await prisma.session.update({ where: { id: sessionId }, data: { preferredModelJson: COVERAGE('deepseek-v4-flash', 'low') } })
    // wikis.ensure 门：run 启动读行（executeRun 776 行）之后、preferred 解析（809 行）之前挂起
    let release!: () => void
    let entered = false
    const gate = new Promise<void>((resolve) => { release = resolve })
    const svc = makeService({ wikis: { ensure: async () => { entered = true; await gate } } })
    const pending = svc.execute(cmd())
    await vi.waitFor(() => expect(entered).toBe(true))
    // 门内换档（low → high）：本 run 的 session 行早已读出（值快照），不感知
    await prisma.session.update({ where: { id: sessionId }, data: { preferredModelJson: COVERAGE('deepseek-v4-flash', 'high') } })
    release()
    await pending
    expect(hub.types().at(-1)).toBe('run.completed')
    expect(builds.captured).toHaveLength(1)
    expect(bindingOf(builds.captured[0]!.model)).toEqual({
      model: 'deepseek-v4-flash',
      modelKwargs: { reasoning_effort: 'low' },
    })
    // 下一 run 读到新档 → 新图
    await svc.execute(cmd())
    expect(builds.captured).toHaveLength(2)
    expect(bindingOf(builds.captured[1]!.model)).toEqual({
      model: 'deepseek-v4-flash',
      modelKwargs: { reasoning_effort: 'high' },
    })
  })

  it('fence 锁：preferredModelJson（含 effort）变更前后 ctx.llm 装配产物逐字段不变（默认链 / env pin / 插件指派三支全锁）', async () => {
    // ctx.llm 解析链三支（env pin > 用户指派 > 默认链）均不读 session 行——覆盖写/清零两态下，
    // 工厂调用参数与解析产物（裸实例、零 withConfig）逐字段一致（llmToolPort 结构性 fence）。
    // 指派行先落库再取快照（快照携带 pluginAssignments——llmToolPort 解析源）。
    await prisma.pluginLlmAssignment.create({
      data: { ownerId: owner.id, pluginId: 'fence-probe', providerId: 'prov-eff', modelId: 'deepseek-v4-flash' },
    })
    const withConfigCalls: Array<Record<string, unknown> | undefined> = []
    const factoryCalls: Array<{ model: string; opts: unknown }> = []
    const factory: ChatModelFactory = async (model, opts) => {
      factoryCalls.push({ model, opts })
      const stub = {
        invoke: async () => ({ content: `fake:${model}` }),
        withConfig(cfg?: { configurable?: Record<string, unknown> }) {
          withConfigCalls.push(cfg?.configurable)
          return { bound: stub, invoke: stub.invoke }
        },
      }
      return stub as unknown as import('@langchain/core/language_models/chat_models').BaseChatModel
    }
    const registry = new ProviderRegistry(prisma, { llmApiKey: 'test-key', modelFactory: factory })
    const snapshot = await registry.getSnapshot(owner.id)
    const invokePort = async (opts: { pluginId: string; model?: string }): Promise<string> => {
      const port = createLlmToolPort({ registry, ownerId: owner.id, pluginId: opts.pluginId, snapshot })
      const res = await port.generateMultimodal({
        contents: ['hi'],
        model: opts.model ?? '',
        maxTokens: 256,
        temperature: 0,
      })
      return res.text
    }
    // 三支：默认链（无指派 pluginId）/ env pin（model 指名）/ 用户指派（fence-probe 行）
    const variants = [
      { pluginId: 'no-assignment-plugin' },
      { pluginId: 'no-assignment-plugin', model: 'deepseek-v4-flash' },
      { pluginId: 'fence-probe' },
    ] as const

    await prisma.session.update({ where: { id: sessionId }, data: { preferredModelJson: COVERAGE('deepseek-v4-flash', 'max') } })
    const coveredTexts = await Promise.all(variants.map((v) => invokePort(v)))
    const afterCoveredCalls = factoryCalls.length

    await prisma.session.update({ where: { id: sessionId }, data: { preferredModelJson: null } })
    const clearedTexts = await Promise.all(variants.map((v) => invokePort(v)))

    expect(coveredTexts).toEqual(['fake:deepseek-v4-flash', 'fake:deepseek-v4-flash', 'fake:deepseek-v4-flash'])
    expect(coveredTexts).toEqual(clearedTexts) // 覆盖变更前后解析产物逐字段一致
    // 清空覆盖后零新增工厂调用 = 三支解析走同一缓存实例（绑定面零变化）
    expect(factoryCalls.slice(afterCoveredCalls)).toEqual([])
    expect(withConfigCalls).toEqual([]) // ctx.llm 全支 = 裸实例，永不携带 effort 绑定
  })
})
