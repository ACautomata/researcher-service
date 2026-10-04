// S1 信封级集成（#777）：发消息到 run 终态的端到端事件序列（#747 C 节 run 域目录帧序列断言）。
// 断言落在 hub.publish 收集层（传输面 = SSE 帧层 id/event/data + serverSeq，#773 encodeFrame
// 已锁）——REST 入队面归 #778，届时补 supertest 端到端。
// 基建全 fake：ScriptedChatModel（脚本化 LLM）+ fakePrimitives（内存 Docker）+ 收集器 hub +
// 临时 SQLite（checkpoint 落库 + session/provider seed）。验收面：
//   - 事件序列形状（run.started → text/thinking.delta → tool.start/end → 终态）
//   - 错误三分类各有用例（story 10）
//   - abort（story 8 by:user）
//   - 同 thread 严格串行（#723 责任面）
//   - interrupt → resume（run.resumed 首事件 + 副作用恰一次 + 50001 竞态败方 + 50003 interrupted 禁输入）
//   - tracing 关闭无泄漏（env + fetch spy 双保险）
// 每用例独立 registry/RunService（模型缓存 key 含脚本消费状态不成立——跨 run 复用会命中
// 已耗尽的脚本模型），hub/prisma 共享。

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { AIMessage } from '@langchain/core/messages'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { PrismaCheckpointSaver } from '../src/runner/persistence/prismaCheckpointSaver'
import { ProviderRegistry } from '../src/runner/providerRegistry'
import { ConcurrencyGate } from '../src/runner/concurrency'
import { RunService, type RunCommand } from '../src/runner/runtime/runService'
import { TeammateService } from '../src/runner/teammates/service'
import { CODE } from '../src/codes'
import { seedAdmin, seedUser } from './helpers'
import {
  ScriptedChatModel,
  fakePrimitives,
  CollectingHub,
  toolCallAi,
  type ScriptEntry,
} from './runnerFakes'
import { installAbortRejectionGuard } from '../src/runner/runtime/abortGuard'

const WIKI = 'researcher-wiki-u1'
const LAB = 'researcher-sandbox-s1'

describe('RunService：发消息 → run 终态事件序列（S1，#747 C 节目录）', () => {
  let prisma: PrismaClient
  let hub: CollectingHub
  let owner: { id: string; username: string }
  const sessionId = 'sess-1'
  let currentScript: ScriptEntry[]
  const cleanupDirs: string[] = []

  beforeAll(async () => {
    // abort 用例会触发 LangGraph abortPromise 泄漏（abortGuard.ts 头注）——测试进程同款守门
    installAbortRejectionGuard()
    const dir = mkdtempSync(path.join(tmpdir(), 'runner-test-'))
    cleanupDirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma, 'runner-user1', 'pw-runner1-secure')
    owner = { id: user.id, username: user.username }
    await prisma.session.create({
      data: { id: sessionId, ownerId: user.id, containerId: LAB, title: '' },
    })
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
    hub = new CollectingHub()
  }, 30_000)

  afterAll(async () => {
    await prisma.$disconnect()
  })

  afterEach(async () => {
    hub.reset()
    currentScript = []
    await prisma.session.deleteMany({ where: { isTeammate: true } })
  })

  // 每用例独立 RunService（独立 registry → 独立模型实例；脚本状态不跨用例污染）。
  function makeService(
    opts: {
      script?: ScriptEntry[]
      scriptLoop?: boolean
      primitives?: ReturnType<typeof fakePrimitives>
      recursionLimit?: number
      interruptPolicyFor?: (sessionId: string) => { tools: readonly string[] } | undefined
      gate?: ConcurrencyGate
      saver?: PrismaCheckpointSaver
      sandboxes?: {
        ensure: (sessionId: string) => Promise<{ containerId: string }>
        touch: (sessionId: string) => void
      }
      wikis?: {
        ensure: (ownerId: string) => Promise<void>
      }
      teammates?: TeammateService
    } = {},
  ): RunService {
    const script = opts.script ?? currentScript
    const registry = new ProviderRegistry(prisma, {
      llmApiKey: 'test-key',
      modelFactory: async () => new ScriptedChatModel(script, { loop: opts.scriptLoop }),
    })
    return new RunService({
      prisma,
      registry,
      saver: opts.saver ?? new PrismaCheckpointSaver(prisma),
      gate: opts.gate ?? new ConcurrencyGate({ globalLimit: 8, loadUserLimit: async () => 4 }),
      hub,
      primitives: (opts.primitives ?? fakePrimitives()).primitives,
      resolveWikiContainer: () => WIKI,
      ...(opts.interruptPolicyFor ? { interruptPolicyFor: opts.interruptPolicyFor } : {}),
      ...(opts.recursionLimit !== undefined ? { recursionLimit: opts.recursionLimit } : {}),
      ...(opts.sandboxes ? { sandboxes: opts.sandboxes } : {}),
      ...(opts.wikis ? { wikis: opts.wikis } : {}),
      ...(opts.teammates ? { teammates: opts.teammates } : {}),
      clock: (() => {
        let t = 0
        return () => (t += 10)
      })(),
    })
  }

  function cmd(p: Partial<RunCommand> = {}): RunCommand {
    return {
      runId: `run-${Math.random().toString(36).slice(2, 10)}`,
      sessionId,
      ownerId: owner.id,
      username: owner.username,
      kind: 'message',
      content: 'hello',
      ...p,
    }
  }

  it('纯文本回复：run.started → text.delta* → run.completed（delta 拼接 == 全文）', async () => {
    currentScript = [new AIMessage({ content: '你好，我是助手。' })]
    const svc = makeService()
    await svc.execute(cmd())
    const types = hub.types()
    expect(types[0]).toBe('run.started')
    expect(types[types.length - 1]).toBe('run.completed')
    expect(types.slice(1, -1).every((t) => t === 'text.delta')).toBe(true)
    expect(types.length).toBeGreaterThan(2) // 流式多 delta（4 字符分片）
    const joined = hub.events
      .filter((e) => e.type === 'text.delta')
      .map((e) => (e.payload as { delta: string }).delta)
      .join('')
    expect(joined).toBe('你好，我是助手。')
    // 归属盖印：全部事件带 sessionId + runId，扇出目标是 owner
    expect(hub.events.every((e) => e.userId === owner.id && e.sessionId === sessionId)).toBe(true)
    expect(hub.events.every((e) => e.runId === hub.events[0]!.runId)).toBe(true)
    expect(svc.stateOf(sessionId)?.state).toBe('completed')
  })

  it('独立恢复的 teammate 按父会话占一份配额，事件带 teammateId', async () => {
    const teammateId = 'teammate-run-1'
    const threadId = 'teammate-thread-1'
    await prisma.session.create({
      data: { id: threadId, ownerId: owner.id, containerId: LAB, title: 'review', isTeammate: true },
    })
    await prisma.teammate.create({
      data: {
        id: teammateId, parentSessionId: sessionId, threadId, name: 'review', task: 'Review this topic', status: 'running',
      },
    })
    const gate = new ConcurrencyGate({ globalLimit: 1, loadUserLimit: async () => 1 })
    const svc = makeService({
      script: [
        () => { expect(gate.inFlight(owner.id)).toBe(1); return toolCallAi('team-skill', 'read_official_skill', { name: 'research' }) },
        toolCallAi('team-list', 'list_teammates', {}),
        new AIMessage({ content: 'Teammate result' }),
      ],
      gate,
      teammates: new TeammateService(prisma),
    })

    await svc.execute(cmd({
      sessionId: threadId,
      parentSessionId: sessionId,
      teammateId,
      content: 'Review this topic',
    }))

    const teammateDeltas = hub.events.filter((event) => event.type === 'text.delta')
    expect(teammateDeltas.length).toBeGreaterThan(0)
    expect(teammateDeltas.every((event) => event.sessionId === sessionId && event.teammateId === teammateId)).toBe(true)
    expect(hub.events.filter((event) => event.type === 'tool.end').map((event) => event.payload)).toEqual([
      expect.objectContaining({ name: 'read_official_skill', state: 'success', details: expect.stringContaining('调研') }),
      expect.objectContaining({ name: 'list_teammates', state: 'success', details: expect.stringContaining('review') }),
    ])
    expect(hub.events.at(-1)).toMatchObject({ type: 'teammate.completed', sessionId, teammateId })
    expect(svc.stateOf(threadId)?.state).toBe('completed')
    expect(gate.inFlight(owner.id)).toBe(0)
  })

  it('工具调用面：text → tool.start → tool.end{state,durationMs} → text → run.completed', async () => {
    const svc = makeService({
      script: [
        toolCallAi('c1', 'write_file', { path: '/lab/notes/a.txt', content: 'hi' }, '我来写文件。'),
        new AIMessage({ content: '写好了。' }),
      ],
    })
    await svc.execute(cmd())
    const types = hub.types()
    expect(types).toContain('tool.start')
    expect(types).toContain('tool.end')
    expect(types[types.length - 1]).toBe('run.completed')
    const start = hub.events.find((e) => e.type === 'tool.start')!
    expect(start.payload).toMatchObject({ toolCallId: 'c1', name: 'write_file' })
    const end = hub.events.find((e) => e.type === 'tool.end')!
    expect(end.payload).toMatchObject({ toolCallId: 'c1', name: 'write_file', state: 'success' })
    // durationMs 来自步进时钟（确定性非零）
    expect((end.payload as { durationMs: number }).durationMs).toBeGreaterThan(0)
  })

  it('thinking 分流：thinking 块 → thinking.delta（与 text 分轨不串流）', async () => {
    const svc = makeService({
      script: [
        new AIMessage({
          content: [
            { type: 'thinking', thinking: '先想一下。' },
            { type: 'text', text: '答案在此。' },
          ],
        }),
      ],
    })
    await svc.execute(cmd())
    const think = hub.events.filter((e) => e.type === 'thinking.delta')
    const text = hub.events.filter((e) => e.type === 'text.delta')
    expect(think.map((e) => (e.payload as { delta: string }).delta).join('')).toBe('先想一下。')
    expect(text.map((e) => (e.payload as { delta: string }).delta).join('')).toBe('答案在此。')
  })

  it('tool.end details >4KB 截断 + truncated 标记（execute 大输出）', async () => {
    const fs = fakePrimitives({
      execBehavior: () => ({ exitCode: 0, stdout: 'x'.repeat(5000), stderr: '' }),
    })
    const svc = makeService({
      primitives: fs,
      script: [toolCallAi('c9', 'execute', { command: 'big' }), new AIMessage({ content: 'done' })],
    })
    await svc.execute(cmd())
    const end = hub.events.find((e) => e.type === 'tool.end')!
    const payload = end.payload as { details: string; truncated?: boolean }
    expect(Buffer.byteLength(payload.details, 'utf8')).toBeLessThanOrEqual(4096)
    expect(payload.truncated).toBe(true)
  })

  it('llm_error：执行中 LLM 故障（HTTP status 形态，MiddlewareError 包装）→ run.failed{llm_error}', async () => {
    const svc = makeService({
      script: [
        () => {
          throw Object.assign(new Error('502 from provider'), { status: 502 })
        },
      ],
    })
    await svc.execute(cmd())
    const last = hub.events[hub.events.length - 1]!
    expect(last.type).toBe('run.failed')
    expect((last.payload as { errorKind: string }).errorKind).toBe('llm_error')
    expect(svc.stateOf(sessionId)?.state).toBe('failed')
  })

  it('recursion_limit：脚本无限工具调用 + 小 recursionLimit → run.failed{recursion_limit}', async () => {
    let seq = 0
    const svc = makeService({
      script: [() => toolCallAi(`cx-${(seq += 1)}`, 'execute', { command: 'loop' })],
      scriptLoop: true,
      recursionLimit: 6,
    })
    await svc.execute(cmd())
    const last = hub.events[hub.events.length - 1]!
    expect(last.type).toBe('run.failed')
    expect((last.payload as { errorKind: string }).errorKind).toBe('recursion_limit')
    expect(svc.stateOf(sessionId)?.state).toBe('failed')
  })

  it('infra：checkpoint 落库故障 → run.failed{errorKind:infra}', async () => {
    class BrokenSaver extends PrismaCheckpointSaver {
      async put(): Promise<never> {
        throw new Error('sqlite corrupted')
      }
    }
    const svc = makeService({
      saver: new BrokenSaver(prisma),
      script: [new AIMessage({ content: 'hi' })],
    })
    await svc.execute(cmd())
    const last = hub.events[hub.events.length - 1]!
    expect(last.type).toBe('run.failed')
    expect((last.payload as { errorKind: string }).errorKind).toBe('infra')
  })

  it('abort：执行中中断 → run.aborted{by:user}（story 8）', async () => {
    const fs = fakePrimitives({
      execBehavior: async () => {
        await new Promise((r) => setTimeout(r, 200))
        return { exitCode: 0, stdout: 'slow', stderr: '' }
      },
    })
    const svc = makeService({
      primitives: fs,
      script: [toolCallAi('cA', 'execute', { command: 'slow' }), new AIMessage({ content: 'done' })],
    })
    const c = cmd()
    const running = svc.execute(c)
    // run.started 出现后中断（窗口 = exec 延迟）
    for (let i = 0; i < 100 && !hub.types().includes('run.started'); i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(svc.abort(c.runId, 'user')).toBe(true)
    await running
    const last = hub.events[hub.events.length - 1]!
    expect(last.type).toBe('run.aborted')
    expect((last.payload as { by: string }).by).toBe('user')
    expect(svc.stateOf(sessionId)?.state).toBe('aborted')
  }, 15_000)

  it('沙箱 ensure/touch 接线：run 前 ensure，lab 工具落在 ensure 返回的容器（#776 契约「消费方 = #777」）', async () => {
    const ensured: string[] = []
    const touched: string[] = []
    const fs = fakePrimitives()
    const svc = makeService({
      primitives: fs,
      script: [toolCallAi('cS', 'execute', { command: 'echo hi' }), new AIMessage({ content: 'ok' })],
      sandboxes: {
        ensure: async (sid) => {
          ensured.push(sid)
          return { containerId: 'researcher-sandbox-ensured' }
        },
        touch: (sid) => touched.push(sid),
      },
    })
    await svc.execute(cmd())
    expect(hub.types()[hub.types().length - 1]).toBe('run.completed')
    expect(ensured).toEqual([sessionId])
    expect(touched.length).toBeGreaterThan(0) // 事件流活动刷新闲置计时（真 activity 源）
    // backend 工具落在 ensure 返回的容器（而非 seed 的 session.containerId 陈旧值）
    expect(fs.execCalls[0]?.container).toBe('researcher-sandbox-ensured')
  })

  it('wiki 容器 ensure 接线：run 前 ensure(ownerId)（#784 契约「双容器 run 前就绪」）', async () => {
    const ensured: string[] = []
    const svc = makeService({
      script: [new AIMessage({ content: 'ok' })],
      wikis: {
        ensure: async (ownerId) => {
          ensured.push(ownerId)
        },
      },
    })
    await svc.execute(cmd())
    expect(hub.types()[hub.types().length - 1]).toBe('run.completed')
    expect(ensured).toEqual([cmd().ownerId])
  })

  it('wiki 容器 ensure 失败 → pre-start 面向上传播（不发 run 域事件，沙箱同先例）', async () => {
    const svc = makeService({
      script: [new AIMessage({ content: 'ok' })],
      wikis: {
        ensure: async () => {
          throw new Error('simulated wiki ensure failure')
        },
      },
    })
    await expect(svc.execute(cmd())).rejects.toThrow('simulated wiki ensure failure')
    expect(hub.types()).not.toContain('run.started')
  })

  it('同 thread 严格串行：第二个 run 的 run.started 晚于第一个 run 的终态', async () => {
    const svc = makeService({ script: [new AIMessage({ content: 'first' })] })
    const c1 = cmd()
    const c2 = cmd()
    await Promise.all([svc.execute(c1), svc.execute(c2)])
    const tagged = hub.events.map((e) => `${e.type}:${e.runId}`)
    const firstDone = tagged.findIndex((s) => s.startsWith('run.completed:') && s.endsWith(c1.runId))
    const secondStart = tagged.findIndex((s) => s.startsWith('run.started:') && s.endsWith(c2.runId))
    expect(firstDone).toBeGreaterThanOrEqual(0)
    expect(secondStart).toBeGreaterThan(firstDone)
  })

  it('stateOf 观测面：排队窗口保持 running（queued 占位不覆盖活跃态——#778 门禁消费面）', async () => {
    const fs = fakePrimitives({
      execBehavior: async () => {
        await new Promise((r) => setTimeout(r, 100))
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })
    const svc = makeService({
      primitives: fs,
      script: [
        toolCallAi('q1', 'execute', { command: 'slow' }),
        new AIMessage({ content: 'one' }),
        new AIMessage({ content: 'two' }),
      ],
    })
    const c1 = cmd()
    const running = svc.execute(c1)
    for (let i = 0; i < 100 && !hub.types().includes('run.started'); i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    const queued = svc.execute(cmd()) // 排队窗口：c2 入链
    expect(svc.stateOf(sessionId)?.state).toBe('running') // 不被 queued 覆盖
    await Promise.all([running, queued])
    expect(svc.stateOf(sessionId)?.state).toBe('completed')
  })

  it('interrupt → resume：interrupted 态无终态事件，resume 后 completed 且工具恰执行一次', async () => {
    const fs = fakePrimitives()
    const svc = makeService({
      primitives: fs,
      interruptPolicyFor: () => ({ tools: ['execute'] }),
      script: [
        toolCallAi('cH', 'execute', { command: 'echo hi' }),
        new AIMessage({ content: '执行完成。' }),
        new AIMessage({ content: '续聊回复。' }), // resume 完成后的 followup 轮
      ],
    })
    await svc.execute(cmd())
    expect(hub.types()).not.toContain('run.completed')
    expect(svc.stateOf(sessionId)?.state).toBe('interrupted')
    expect(fs.execCalls).toHaveLength(0) // interrupt 前副作用未发生（硬约束）

    const rc = svc.buildResumeCommand({
      sessionId,
      ownerId: owner.id,
      username: owner.username,
      decisions: { decisions: [{ type: 'approve' }] },
    })
    const beforeResume = hub.events.length
    await svc.execute(rc)
    // resume 首事件 = run.resumed（#747 C 节目录与 run.started 并列——续跑不重发 started）
    expect(hub.events[beforeResume]?.type).toBe('run.resumed')
    expect(hub.types()[hub.types().length - 1]).toBe('run.completed')
    expect(fs.execCalls).toHaveLength(1) // resume 后工具恰执行一次（副作用幂等）
    expect(svc.stateOf(sessionId)?.state).toBe('completed')

    // resume 完成后线程解除 interrupt 态：后续 message 不被 50003 误挡（checkpoint 语义锁定——
    // 续跑后的最新 checkpoint 不再带 pending __interrupt__）
    const followup = await svc.buildMessageCommand({
      sessionId,
      ownerId: owner.id,
      username: owner.username,
      content: '继续',
    })
    await svc.execute(followup)
    expect(svc.stateOf(sessionId)?.state).toBe('completed')
  }, 30_000)

  it('interrupted 态 message → 50003 拒绝（#747 C 节「interrupt 全端可审批」内核防御面）', async () => {
    // 独立 thread：本用例把线程留在 interrupted，不毒化共享 sess-1 的后续用例
    await prisma.session.create({
      data: { id: 'sess-i1', ownerId: owner.id, containerId: LAB, title: '' },
    })
    const svc = makeService({
      interruptPolicyFor: () => ({ tools: ['execute'] }),
      script: [toolCallAi('cI', 'execute', { command: 'x' }), new AIMessage({ content: 'ok' })],
    })
    await svc.execute(cmd({ sessionId: 'sess-i1' }))
    expect(svc.stateOf('sess-i1')?.state).toBe('interrupted')
    await expect(svc.execute(cmd({ sessionId: 'sess-i1', content: '打断' }))).rejects.toMatchObject({
      code: CODE.RUN_INTERRUPT_PENDING,
    })
    // 拒绝在 pre-start 面：无新事件、queued 占位回滚、interrupt 态保持
    expect(svc.stateOf('sess-i1')?.state).toBe('interrupted')
  })

  it('interrupted 态 message → 50003（重启形态：内存缺失走 checkpoint 推导）', async () => {
    await prisma.session.create({
      data: { id: 'sess-i2', ownerId: owner.id, containerId: LAB, title: '' },
    })
    // svc A 打出 interrupt 后弃用；svc B（同 DB、空内存）收到 message 同挡
    const first = makeService({
      interruptPolicyFor: () => ({ tools: ['execute'] }),
      script: [toolCallAi('cI2', 'execute', { command: 'x' }), new AIMessage({ content: 'ok' })],
    })
    await first.execute(cmd({ sessionId: 'sess-i2' }))
    expect(first.stateOf('sess-i2')?.state).toBe('interrupted')

    const reborn = makeService({
      interruptPolicyFor: () => ({ tools: ['execute'] }),
      script: [new AIMessage({ content: 'ok' })],
    })
    await expect(
      reborn.execute(cmd({ sessionId: 'sess-i2', content: '打断' })),
    ).rejects.toMatchObject({ code: CODE.RUN_INTERRUPT_PENDING })
    expect(reborn.stateOf('sess-i2')?.state).toBeUndefined() // pre-start 拒绝，queued 占位已回滚
  })

  it('resume 竞态：interrupted 消费后二次 resume——预检 50001 + executeRun 权威判定 50001', async () => {
    const svc = makeService({
      interruptPolicyFor: () => ({ tools: ['execute'] }),
      script: [
        toolCallAi('cR', 'execute', { command: 'x' }),
        new AIMessage({ content: 'ok' }),
      ],
    })
    await svc.execute(cmd())
    const rc1 = svc.buildResumeCommand({ sessionId, ownerId: owner.id, username: owner.username })
    await svc.execute(rc1) // interrupted 消费 → completed

    // 预检面：state 已推离 interrupted（内存权威可知）→ 50001
    let precheckCode: number | undefined
    try {
      svc.buildResumeCommand({ sessionId, ownerId: owner.id, username: owner.username })
    } catch (e) {
      precheckCode = (e as { code?: number }).code
    }
    expect(precheckCode).toBe(CODE.RUN_ALREADY_RESUMED)

    // 权威面：绕过预检的 resume 命令（BullMQ 传输面形态）→ executeRun 互斥判定 50001
    const bypass = svc.buildCommand({
      sessionId,
      ownerId: owner.id,
      username: owner.username,
      kind: 'resume',
    })
    await expect(svc.execute(bypass)).rejects.toMatchObject({ code: CODE.RUN_ALREADY_RESUMED })
  })

  it('额度 40043：gate 满 → execute 抛 EnvelopeError（权威判定）', async () => {
    const svc = makeService({
      script: [new AIMessage({ content: 'x' })],
      gate: new ConcurrencyGate({ globalLimit: 8, loadUserLimit: async () => 0 }),
    })
    await expect(svc.execute(cmd())).rejects.toMatchObject({ code: CODE.CONCURRENCY_QUOTA_EXCEEDED })
  })

  it('usage 采数接线：带 usage_metadata 的回复落 llm_usage_records（默认链主身份）', async () => {
    const svc = makeService({
      script: [
        new AIMessage({
          content: '计费回复',
          usage_metadata: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
        }),
      ],
    })
    await svc.execute(cmd())
    const rows = await prisma.llmUsageRecord.findMany({ where: { sessionId } })
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0]).toMatchObject({
      runId: hub.events[0]!.runId,
      sessionId,
      userId: owner.id,
      providerId: 'prov-1',
      lcProvider: 'openai',
      model: 'model-x',
      inputTokens: 120,
      outputTokens: 30,
    })
  })

  it('50002：会话不存在 → buildMessageCommand 同码防探测', async () => {
    const svc = makeService({ script: [] })
    await expect(
      svc.buildMessageCommand({
        sessionId: 'no-such-session',
        ownerId: owner.id,
        username: owner.username,
        content: 'hi',
      }),
    ).rejects.toMatchObject({ code: CODE.SESSION_NOT_FOUND })
  })

  it('50002：越权（他人 session）→ 同码防探测（归属判定复用 getSessionForUser）', async () => {
    const other = await seedUser(prisma, 'runner-other', 'pw-runner-other-secure')
    await prisma.session.create({
      data: { id: 'sess-other', ownerId: other.id, containerId: LAB, title: '' },
    })
    const svc = makeService({ script: [] })
    await expect(
      svc.buildMessageCommand({
        sessionId: 'sess-other',
        ownerId: owner.id,
        username: owner.username,
        content: 'hi',
      }),
    ).rejects.toMatchObject({ code: CODE.SESSION_NOT_FOUND })
  })

  it('admin 放行：admin 对他人 session 可发消息（#312⑤ 归属判定同源）', async () => {
    const other = await seedUser(prisma, 'runner-other2', 'pw-runner-other2-secure')
    await prisma.session.create({
      data: { id: 'sess-other2', ownerId: other.id, containerId: LAB, title: '' },
    })
    const admin = await seedAdmin(prisma, 'runner-admin', 'pw-runner-admin-secure')
    const svc = makeService({ script: [] })
    const c = await svc.buildMessageCommand({
      sessionId: 'sess-other2',
      ownerId: admin.id,
      username: admin.username,
      content: 'hi',
    })
    expect(c.kind).toBe('message')
  })

  it('tracing 关闭：构造后 env 显式 false，执行全程无 langsmith 域名请求', async () => {
    const smithCalls: string[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('smith.langchain.com') || url.includes('langsmith')) smithCalls.push(url)
      return origFetch(input, init)
    }) as typeof fetch
    try {
      process.env.LANGCHAIN_TRACING_V2 = 'true' // 模拟用户 env 误开
      const svc = makeService({ script: [new AIMessage({ content: 'ok' })] })
      expect(process.env.LANGCHAIN_TRACING_V2).toBe('false')
      await svc.execute(cmd())
      expect(smithCalls).toEqual([])
    } finally {
      globalThis.fetch = origFetch
      delete process.env.LANGCHAIN_TRACING_V2
    }
  })
})
