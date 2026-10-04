// S4 行为快照（#777 · #747 Testing Decisions「PoC #724 断言集（6/6）固化为可重复执行快照，
// 三包联动升级的守门基线」）。断言集映射 PoC 场景（throwaway 分支 prototype/724-agent-loop-poc）：
//
//   S2（PoC interrupt→断线→resume）：
//     A1  interrupt 后 run 停在 interrupted、checkpoint 落库、interrupt 前副作用未发生
//     A2  「断线」= 全新栈（新 registry/saver/RunService，仅共享 DB）resume 跑完 completed
//     A3  resume 后 backend 工具恰好执行一次（interrupt 前副作用幂等/后置硬约束的锁定面）
//   S3（PoC 跨进程 replay）：独立子进程（tsx spawn）全新栈：
//     B1  独立 getTuple 读回完整历史（checkpoint blob 自包含）
//     B2  followup 凭历史直答 0 工具调用（模型脚本扫描式取答案——脚本不含答案本身）
//   事件桥（协议事件形状）：归一化后固化为文件快照——三包升级 diff 审查面（C 节目录形状守门）
//     C1  v3 protocol events → 自有目录的完整投影序列快照
//   断线补偿 + 重启恢复（#779 · story 11/14 增补）：
//     D1  running 中「断线」（不消费事件）→ in-flight 从 checkpoint blob 还原 ≈ 流式归约
//         快照（无跳变重影：blob 与事件同源同刻）
//     D2  「控制面重启」（全新栈）重放崩溃 job → 转 recover 从 checkpoint 续跑跑完
//         （BullMQ stalled 重放的测试同形面：同 RunCommand 二次 execute）
//
// 全 fake（ScriptedChatModel + fakePrimitives），确定性可重复；版本升级后跑本文件，
// 行为漂移在此红。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
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
import { checkpointHumanCount, seedUser, waitFor } from './helpers'
import { ScriptedChatModel, fakePrimitives, CollectingHub, toolCallAi, type ScriptEntry } from './runnerFakes'

const LAB = 'researcher-sandbox-s4'
const WIKI = 'researcher-wiki-s4'
const SESSION = 'sess-s4'

interface ServiceBundle {
  svc: RunService
  hub: CollectingHub
  fs: ReturnType<typeof fakePrimitives>
}

function cmdOf(owner: { id: string; username: string }, p: Partial<RunCommand> = {}): RunCommand {
  return {
    runId: `s4-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: SESSION,
    ownerId: owner.id,
    username: owner.username,
    kind: 'message',
    content: 'hello',
    ...p,
  }
}

describe('S4 行为快照（#724 断言集 6/6 固化，三包升级守门基线）', () => {
  let prisma: PrismaClient
  let dbUrl: string
  let owner: { id: string; username: string }
  const cleanupDirs: string[] = []

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 's4-snapshot-'))
    cleanupDirs.push(dir)
    const dbPath = path.join(dir, 's4.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    dbUrl = `file:${dbPath}`
    prisma = createPrismaClient(dbUrl)
    const user = await seedUser(prisma, 's4-user', 'pw-s4user-secure')
    owner = { id: user.id, username: user.username }
    await prisma.session.create({
      data: { id: SESSION, ownerId: user.id, containerId: LAB, title: '' },
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
  }, 30_000)

  afterAll(async () => {
    await prisma.$disconnect()
  })

  function makeBundle(opts: {
    script?: () => ScriptEntry[]
    primitives?: ReturnType<typeof fakePrimitives>
    interruptOnExecute?: boolean
  }): ServiceBundle {
    const fs = opts.primitives ?? fakePrimitives()
    const registry = new ProviderRegistry(prisma, {
      llmApiKey: 's4-key',
      modelFactory: async () => new ScriptedChatModel(opts.script ? opts.script() : []),
    })
    const hub = new CollectingHub()
    const svc = new RunService({
      prisma,
      registry,
      saver: new PrismaCheckpointSaver(prisma),
      gate: new ConcurrencyGate({ globalLimit: 4, loadUserLimit: async () => 2 }),
      hub,
      primitives: fs.primitives,
      resolveWikiContainer: () => WIKI,
      ...(opts.interruptOnExecute ? { interruptPolicyFor: () => ({ tools: ['execute'] }) } : {}),
    })
    return { svc, hub, fs }
  }

  // ---- S2：interrupt → 断线 → resume（PoC S2 固化；三场景一气呵成，断言分段）----

  it('A1+A2+A3：interrupt → 断线（全新栈）→ resume 跑完且工具恰执行一次', async () => {
    const first = makeBundle({
      primitives: fakePrimitives(),
      interruptOnExecute: true,
      script: () => [
        toolCallAi('s4-c1', 'execute', { command: 'echo seed' }),
        new AIMessage({ content: [{ type: 'text', text: '执行完成，报告就绪。' }] }),
      ],
    })
    const { svc, hub, fs } = first
    await svc.execute(cmdOf(owner))

    // A1：停在中断 + checkpoint 落库 + 副作用未发生
    expect(svc.stateOf(SESSION)?.state).toBe('interrupted')
    expect(hub.types()).not.toContain('run.completed')
    const cpRows = await prisma.checkpoint.count({ where: { threadId: SESSION } })
    expect(cpRows).toBeGreaterThan(0)
    expect(fs.execCalls).toHaveLength(0)

    // ---- 断线：全新栈（新 provider/saver/RunService；仅共享 DB）----
    // reborn 脚本只含最终回复：interrupt 时产出 tool call 的模型轮已消耗在 checkpoint 里，
    // resume 后 HITL 放行执行工具，模型从工具结果继续（「resume 从头重跑」的消耗语义）。
    const reborn = makeBundle({
      primitives: fs,
      interruptOnExecute: true,
      script: () => [new AIMessage({ content: [{ type: 'text', text: '执行完成，报告就绪。' }] })],
    })
    // 新栈内存 runs 为空（=「断线」/控制面重启形态）：buildResumeCommand 预检放行不误报
    // 50001——权威判定从 checkpoint 推导（runService.ts threadInterruptedFromCheckpoint）。
    const resume = reborn.svc.buildResumeCommand({
      sessionId: SESSION,
      ownerId: owner.id,
      username: owner.username,
      decisions: { decisions: [{ type: 'approve' }] },
    })
    await reborn.svc.execute(resume)

    // A2：resume 跑完（首事件 = run.resumed——#747 C 节目录与 run.started 并列）
    expect(reborn.hub.types()[0]).toBe('run.resumed')
    expect(reborn.hub.types()[reborn.hub.types().length - 1]).toBe('run.completed')
    expect(reborn.svc.stateOf(SESSION)?.state).toBe('completed')
    // A3：工具恰执行一次（interrupt 前未执行 + resume 后执行一次 = 1）
    expect(fs.execCalls).toHaveLength(1)
    // resume 流的正文投影完整
    const text = reborn.hub.events
      .filter((e) => e.type === 'text.delta')
      .map((e) => (e.payload as { delta: string }).delta)
      .join('')
    expect(text).toContain('执行完成')
  }, 30_000)

  // ---- S3：跨进程 replay（独立 tsx 子进程，全新栈凭历史直答）----

  it('B1+B2：独立进程 getTuple 读回历史 + followup 凭历史直答 0 工具调用', async () => {
    // 前置 run：往 thread 里写带种子的事实（答案只出现在这里）
    const seed = makeBundle({
      script: () => [new AIMessage({ content: [{ type: 'text', text: '好的，我记住了：你的幸运数字是 42。' }] })],
    })
    await seed.svc.execute(cmdOf(owner, { content: '我的幸运数字是 42，请记住。' }))
    expect(seed.svc.stateOf(SESSION)?.state).toBe('completed')

    // 独立子进程：tsx 跑 runnerReplayChild.mts（新 Prisma/新 saver/新 RunService）
    const tsxCli = path.join(process.cwd(), 'node_modules', '.bin', 'tsx')
    const childScript = path.join(process.cwd(), 'test', 'runnerReplayChild.mts')
    expect(existsSync(tsxCli)).toBe(true)
    const child = spawn(tsxCli, [childScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REPLAY_DB_URL: dbUrl,
        REPLAY_THREAD_ID: SESSION,
        REPLAY_OWNER_ID: owner.id,
        REPLAY_USERNAME: owner.username,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`replay child 超时\nstdout=${stdout}\nstderr=${stderr}`)), 60_000)
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
      child.on('error', reject)
    })
    const line = stdout.split('\n').find((l) => l.startsWith('REPLAY_RESULT '))
    expect(line, `子进程无结果输出（exit=${exit}）\nstdout=${stdout}\nstderr=${stderr}`).toBeDefined()
    const result = JSON.parse(line!.slice('REPLAY_RESULT '.length)) as {
      ok: boolean
      historyLen: number
      scannedAnswer: string | null
      toolCalls: number
      error?: string
      cvKeys?: string
    }
    // B2 前置：子进程自身无错误（诊断面带全量输出）
    expect(result.error, `子进程错误：${result.error ?? '(null)'}\nstdout=${stdout}\nstderr=${stderr}`).toBeUndefined()
    // B1：独立 getTuple 读回完整历史（user + assistant ≥ 2）
    expect(result.historyLen, `historyLen=0（channelValues keys: ${result.cvKeys}）`).toBeGreaterThanOrEqual(2)
    // B2：凭历史直答（扫描到 42）且 0 工具调用（PoC S3 直答语义）
    expect(result.scannedAnswer).toBe('42')
    expect(result.toolCalls).toBe(0)
    expect(result.ok).toBe(true)
  }, 90_000)

  // ---- 事件桥：协议事件形状固化（C 节目录守门快照）----

  it('C1：v3 protocol events → 自有目录投影序列快照（升级 diff 审查面）', async () => {
    const bundle = makeBundle({
      primitives: fakePrimitives(),
      script: () => [
        new AIMessage({
          content: [
            { type: 'thinking', thinking: '先想一步。' },
            { type: 'text', text: '我来写文件。' },
          ],
          tool_calls: [{ id: 'snap-call-1', name: 'write_file', args: { path: '/lab/snap.txt', content: 'hello snapshot' } }],
        }),
        new AIMessage({ content: [{ type: 'text', text: '写好了。' }] }),
      ],
    })
    const c = cmdOf(owner)
    await bundle.svc.execute(c)
    // 归一化：runId 随机、durationMs 依真实时钟（0/1ms 抖动）——快照只锁形状与序列，
    // 值归一为占位（守门不得因计时抖动 flaky）。
    const normalize = (p: unknown): unknown => {
      if (Array.isArray(p)) return p.map(normalize)
      if (p !== null && typeof p === 'object') {
        return Object.fromEntries(
          Object.entries(p).map(([k, v]) => [k, k === 'durationMs' ? '<durationMs>' : normalize(v)]),
        )
      }
      return p
    }
    const normalized = bundle.hub.events.map((e) => ({
      type: e.type,
      ...(e.payload !== undefined ? { payload: normalize(e.payload) } : {}),
    }))
    await expect(JSON.stringify(normalized, null, 1)).toMatchFileSnapshot(
      '__snapshots__/s4-event-bridge-shape.snap.json',
      '事件桥投影形状（三包升级守门——diff 即行为漂移，人工确认后更新）',
    )
  })

  // ---- 断线补偿（story 11）：in-flight 从 checkpoint blob 还原 ----

  it('D1：running 中断线 → in-flight blob 还原 ≈ 流式归约快照（无跳变重影）', async () => {
    // 慢工具窗口 = 断线观察窗：模型轮（含文本）已入 checkpoint、工具执行中
    const bundle = makeBundle({
      primitives: fakePrimitives({
        execBehavior: async () => {
          await new Promise((r) => setTimeout(r, 300))
          return { exitCode: 0, stdout: 'fake-exec-out', stderr: '' }
        },
      }),
      script: () => [
        new AIMessage({
          content: [{ type: 'text', text: '断线前的模型输出。' }],
          tool_calls: [{ id: 's4-d1', name: 'execute', args: { command: 'echo slow' } }],
        }),
        new AIMessage({ content: [{ type: 'text', text: '断线后的收尾。' }] }),
      ],
    })
    const cmd = cmdOf(owner, { content: '断线场景' })
    const running = bundle.svc.execute(cmd)
    // 等工具行进 checkpoint（慢窗口）
    let inflight: Awaited<ReturnType<typeof bundle.svc.inFlightProjection>>
    // blob 边界不变量（story 11「无跳变重影」的行为契约）：重建 content 恒为已流出
    // text.delta 拼接的前缀——blob 只含已落 super-step 的消息，宁短不假（正在生成的 delta
    // 未入 blob 是 LangGraph blob 边界粒度固有；每次探测断言前缀关系即「重建 ⊆ 流出」锁定）
    const streamedSoFar = () =>
      bundle.hub.events
        .filter((e) => e.type === 'text.delta')
        .map((e) => (e.payload as { delta: string }).delta)
        .join('')
    await waitFor(async () => {
      inflight = await bundle.svc.inFlightProjection(SESSION)
      expect(streamedSoFar().startsWith(inflight?.turn.content ?? '')).toBe(true)
      return (inflight?.turn.tools?.length ?? 0) > 0
    })
    expect(inflight?.state).toBe('running')
    // 「无跳变重影」断言：blob 还原的 turn 与同刻事件流归约快照结构一致（同源同刻）
    // ——reducer 面无法直取（RunService 内部），用流式事件同构归约对齐：text.delta 拼接 ≡
    // blob content；tool.start ≡ blob tools 行。
    expect(inflight?.turn.content).toBe(streamedSoFar())
    expect(inflight?.turn.tools?.[0]).toMatchObject({ toolCallId: 's4-d1', name: 'execute', state: 'running' })
    await running

    // 完成后 in-flight 缺省（观测面收敛）
    expect(await bundle.svc.inFlightProjection(SESSION)).toBeUndefined()
  }, 30_000)

  // ---- 重启恢复（story 14）：全新栈重放崩溃 job → recover 续跑 ----

  it('D2：控制面重启后重放崩溃 job → 转 recover 凭 checkpoint 续跑跑完（集成场景）', async () => {
    // 第一段：模型轮中途「崩溃」（进程死——checkpoint 停在 super-step 边界）
    const crashed = cmdOf(owner, { content: '长任务不白费', runId: 's4-d2-fixed' })
    const s1 = makeBundle({
      primitives: fakePrimitives(),
      script: () => [
        toolCallAi('s4-d2', 'execute', { command: 'echo x' }, '先干活。'),
        () => {
          throw new Error('simulated crash')
        },
      ],
    })
    await s1.svc.execute(crashed)
    expect(s1.svc.stateOf(SESSION)?.state).toBe('failed')

    // 第二段：全新栈（新 registry/saver/RunService——「控制面重启」形态）重放同 job
    //（BullMQ stalled 自动重放的测试同形面：同 RunCommand、内存态全失）
    const reborn = makeBundle({
      primitives: s1.fs,
      script: () => [new AIMessage({ content: [{ type: 'text', text: '恢复后续跑完成。' }] })],
    })
    await reborn.svc.execute(crashed)

    // 续跑跑完：run.resumed 起（非 run.started——重放归一化生效的事件面证据）
    const types = reborn.hub.types()
    expect(types[0]).toBe('run.resumed')
    expect(types[types.length - 1]).toBe('run.completed')
    expect(reborn.svc.stateOf(SESSION)?.state).toBe('completed')
    // checkpoint 无重复 user 消息（重放未重复 append——normalizeReplay 判据生效）
    expect(await checkpointHumanCount(prisma, SESSION, '长任务不白费')).toBe(1)
    // 续跑产出经事件面完整流出
    const text = reborn.hub.events
      .filter((e) => e.type === 'text.delta')
      .map((e) => (e.payload as { delta: string }).delta)
      .join('')
    expect(text).toContain('恢复后续跑完成')
  }, 30_000)
})
