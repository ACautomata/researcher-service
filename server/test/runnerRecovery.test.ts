// #779 story 11/14 · S2 fake 集成（RunService 级）：
//
//   story 14 控制面重启 run 续跑——BullMQ v6 stalled job 绕过 attempts 自动重放（#779 探针
//   实测：w1 拾取后崩溃 → w2 stalled check → 同 job 重新执行）。重放拦截 = normalizeReplay
//   checkpoint 判据（message：checkpoint messages 存在 id=runId 的 human；resume：pending
//   interrupt 不在且最新 checkpoint 带 __error__ write——乱调 resume 已完成会话无 error
//   write，权威 50001 保留）→ kind 转 'recover'（null input 从 checkpoint 续跑，#779 探针
//   验证 LangGraph 三形态：null+pendingInterrupt no-op / null+error-write 续跑 /
//   resume-without-interrupt no-op）。
//
//   story 11 in-flight 投影——inFlightProjection：running 态从 checkpoint blob 重建 turn
//   （即焚 token 事件的补偿真相源），queued 态空 turn，无在飞 undefined。
//
// 全 fake（ScriptedChatModel + fakePrimitives）。「崩溃」= 脚本耗尽抛错（super-step 边界
// 停点等价性见 #779 探针：checkpoint 停在最后完成的 put 后，与 SIGKILL 形态同构）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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
import { checkpointHumanCount, seedUser, waitFor } from './helpers'
import { ScriptedChatModel, fakePrimitives, CollectingHub, toolCallAi, type ScriptEntry } from './runnerFakes'

const LAB = 'researcher-sandbox-rec'
const WIKI = 'researcher-wiki-rec'

describe('#779 断线补偿 + 重启恢复（RunService 级）', () => {
  let prisma: PrismaClient
  let hub: CollectingHub
  let owner: { id: string; username: string }
  let sessionSeq = 0
  const cleanupDirs: string[] = []

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'runner-recovery-'))
    cleanupDirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma, 'rec-user', 'pw-rec-user-secure')
    owner = { id: user.id, username: user.username }
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

  // 每用例独立 session（checkpoint thread 隔离——thread 状态交叉污染会让重放判据互相误命中）
  async function newSession(): Promise<string> {
    sessionSeq += 1
    const id = `sess-rec-${sessionSeq}`
    await prisma.session.create({ data: { id, ownerId: owner.id, containerId: LAB, title: '' } })
    return id
  }

  // 每次调用独立 RunService（新栈语义：内存 runs 空 = 「控制面重启」形态）。
  function makeService(opts: {
    script?: ScriptEntry[]
    slowExec?: boolean
    interruptOnExecute?: boolean
    teammates?: TeammateService
  }): RunService {
    const registry = new ProviderRegistry(prisma, {
      llmApiKey: 'rec-key',
      modelFactory: async () => new ScriptedChatModel(opts.script ?? []),
    })
    const svc = new RunService({
      prisma,
      registry,
      saver: new PrismaCheckpointSaver(prisma),
      gate: new ConcurrencyGate({ globalLimit: 4, loadUserLimit: async () => 4 }),
      hub,
      primitives: fakePrimitives({
        execBehavior: async () => {
          if (opts.slowExec) await new Promise((r) => setTimeout(r, 250))
          return { exitCode: 0, stdout: 'fake-exec-out', stderr: '' }
        },
      }).primitives,
      resolveWikiContainer: () => WIKI,
      teammates: opts.teammates,
      ...(opts.interruptOnExecute ? { interruptPolicyFor: () => ({ tools: ['execute'] }) } : {}),
    })
    // recordTurn 注入（SessionService.recordTurn 的落行语义简化镜像：assistant 行 + anchor）
    svc.setRecordTurn(async (p) => {
      const last = await prisma.sessionMessage.findFirst({
        where: { sessionId: p.sessionId },
        orderBy: { turn: 'desc' },
        select: { turn: true },
      })
      await prisma.sessionMessage.create({
        data: {
          sessionId: p.sessionId,
          turn: (last?.turn ?? 0) + 1,
          role: 'assistant',
          content: p.aggregate.content,
          anchorCheckpointId: p.anchorCheckpointId,
          attachmentsJson: JSON.stringify({ v: 1 }),
        },
      })
    })
    return svc
  }

  function cmdOf(sessionId: string, p: Partial<RunCommand> = {}): RunCommand {
    return {
      runId: `rec-${Math.random().toString(36).slice(2, 10)}`,
      sessionId,
      ownerId: owner.id,
      username: owner.username,
      kind: 'message',
      content: 'hello',
      ...p,
    }
  }

  async function projectionMessages(sessionId: string): Promise<{ role: string; content: string; anchorCheckpointId: string | null }[]> {
    const rows = await prisma.sessionMessage.findMany({
      where: { sessionId },
      orderBy: [{ turn: 'asc' }, { createdAt: 'asc' }],
    })
    return rows.map((r) => ({ role: r.role, content: r.content, anchorCheckpointId: r.anchorCheckpointId }))
  }

  // ---- story 14：message 重放 → recover 续跑 ----

  it('mailbox timeout resume recovers after consuming its wait without repeating timeout mail', async () => {
    const session = await newSession()
    const teammates = new TeammateService(prisma)
    const scheduled: RunCommand[] = []
    const first = makeService({
      teammates,
      script: [toolCallAi('mail-wait', 'wait_for_teammate_mail', { timeoutMs: 1000 }), () => { throw new Error('crash after mailbox resume') }],
    })
    first.setTeammateDispatcher(async (command) => { scheduled.push(command) })
    await first.execute(cmdOf(session))
    expect(first.stateOf(session)?.state).toBe('interrupted')
    expect(scheduled).toHaveLength(1)
    const resume = scheduled[0]!
    const parkedEvents = hub.events.length
    await expect(first.execute({ ...resume, mailWaitId: 'stale-wait' })).rejects.toMatchObject({ code: CODE.RUN_ALREADY_RESUMED })
    expect(first.stateOf(session)?.state).toBe('interrupted')
    expect(hub.events).toHaveLength(parkedEvents)

    await first.execute(resume)
    expect(first.stateOf(session)?.state).toBe('failed')
    expect(await teammates.mailboxHistory(session)).toHaveLength(1)

    const reborn = makeService({ teammates, script: [new AIMessage({ content: [{ type: 'text', text: 'Recovered mailbox work' }] })] })
    reborn.setTeammateDispatcher(async () => { throw new Error('recover must not schedule another wait') })
    await reborn.execute(resume)
    expect(reborn.stateOf(session)?.state).toBe('completed')
    expect(await teammates.mailboxHistory(session)).toHaveLength(1)
    expect((await projectionMessages(session)).at(-1)?.content).toBe('Recovered mailbox work')
  })

  it('message 崩溃重放：checkpoint 已含 id=runId → 转 recover，null 续跑跑完，无重复 append', async () => {
    const session = await newSession()
    const crashed = cmdOf(session, { content: '崩溃的问题' })
    // 第一段：工具轮后模型抛错（「崩溃」——checkpoint 停在 super-step 边界）
    const s1 = makeService({
      script: [
        toolCallAi('rec-c1', 'execute', { command: 'echo hi' }, '想想。'),
        () => {
          throw new Error('simulated crash')
        },
      ],
    })
    await s1.execute(crashed)
    expect(s1.stateOf(session)?.state).toBe('failed')
    expect(await checkpointHumanCount(prisma, session, '崩溃的问题')).toBe(1)
    // failed 常规落行（reducer 段「想想。」，anchor=null 残留）
    expect((await projectionMessages(session)).filter((r) => r.role === 'assistant')).toHaveLength(1)

    // 第二段：新栈（内存空）重放同 job（同 runId/content）——normalizeReplay 转 recover
    const s2 = makeService({ script: [new AIMessage({ content: [{ type: 'text', text: '续跑完成。' }] })] })
    await s2.execute(crashed)

    // 转换生效：首事件 run.resumed（非 run.started）
    expect(hub.types().lastIndexOf('run.resumed')).toBeGreaterThan(-1)
    expect(s2.stateOf(session)?.state).toBe('completed')
    // checkpoint 无重复 human（判据生效——正常重放会 append 第二条）
    expect(await checkpointHumanCount(prisma, session, '崩溃的问题')).toBe(1)
    // recover 终态落行以 checkpoint 为准：断点前内容（想想。+ 工具行）+ 断点后续跑完成
    const rows = await projectionMessages(session)
    const last = rows[rows.length - 1]
    expect(last.role).toBe('assistant')
    expect(last.content).toContain('想想。')
    expect(last.content).toContain('续跑完成。')
    expect(last.anchorCheckpointId).not.toBeNull()
    // failed 残留部分行（anchor=null、content 前缀）被全量行替换——双行重叠防御
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(1)
  }, 30_000)

  it('message 未执行重放（排队窗口崩溃）：checkpoint 无该消息 → 正常执行（run.started）', async () => {
    const session = await newSession()
    const queued = cmdOf(session, { content: '排队的问题' })
    // checkpoint 无 id=queued.runId 的消息（该命令从未进图）
    const s = makeService({ script: [new AIMessage({ content: [{ type: 'text', text: '正常回答。' }] })] })
    await s.execute(queued)
    expect(s.stateOf(session)?.state).toBe('completed')
    // 本段事件首项为 run.started（未转换）
    const types = hub.types()
    expect(types.lastIndexOf('run.started')).toBeGreaterThan(types.lastIndexOf('run.resumed'))
    expect(await checkpointHumanCount(prisma, session, '排队的问题')).toBe(1)
  }, 30_000)

  it('resume 中途崩溃重放：RESUME 已消费且无 interrupt → 转 recover 续跑', async () => {
    const session = await newSession()
    const seed = makeService({
      interruptOnExecute: true,
      script: [
        toolCallAi('rec-c2', 'execute', { command: 'echo hi' }, '想想。'),
        () => {
          throw new Error('crash after resume')
        },
      ],
    })
    await seed.execute(cmdOf(session, { content: '带审批的问题' }))
    expect(seed.stateOf(session)?.state).toBe('interrupted')

    // resume 命令执行中「崩溃」（脚本第二轮抛错——RESUME write 已消费）
    const resumeCmd = cmdOf(session, {
      runId: 'rec-resume-1',
      kind: 'resume',
      decisions: { decisions: [{ type: 'approve' }] },
    })
    await seed.execute(resumeCmd)
    expect(seed.stateOf(session)?.state).toBe('failed')

    // 新栈重放同 resume 命令 → 转 recover → null 续跑
    const s2 = makeService({ script: [new AIMessage({ content: [{ type: 'text', text: '恢复续答。' }] })] })
    await s2.execute(resumeCmd)
    expect(s2.stateOf(session)?.state).toBe('completed')
    const types = hub.types()
    expect(types.lastIndexOf('run.resumed')).toBeGreaterThan(types.lastIndexOf('run.started'))
    const rows = await projectionMessages(session)
    expect(rows[rows.length - 1].content).toContain('恢复续答。')
    // resume failed 残留行（空 content 纯工具行，空前缀天然命中）同样被全量替换——双行防御
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(1)
  }, 30_000)

  it('resume 未执行重放：pending interrupt 在场 → 正常 resume 重试（非 recover）', async () => {
    const session = await newSession()
    const seed = makeService({
      interruptOnExecute: true,
      script: [
        toolCallAi('rec-c3', 'execute', { command: 'echo hi' }, '想想。'),
        new AIMessage({ content: [{ type: 'text', text: '不该被调。' }] }),
      ],
    })
    await seed.execute(cmdOf(session, { content: '另一审批问题' }))
    expect(seed.stateOf(session)?.state).toBe('interrupted')

    // 排队即崩（RESUME 未落，interrupt 在）——重放 = resume 重试
    const resumeCmd = cmdOf(session, {
      runId: 'rec-resume-2',
      kind: 'resume',
      decisions: { decisions: [{ type: 'approve' }] },
    })
    const s2 = makeService({
      interruptOnExecute: true,
      script: [new AIMessage({ content: [{ type: 'text', text: '重试成功。' }] })],
    })
    await s2.execute(resumeCmd)
    expect(s2.stateOf(session)?.state).toBe('completed')
    expect(await checkpointHumanCount(prisma, session, '另一审批问题')).toBe(1)
  }, 30_000)

  it('图已完成重放：recover no-op → 防双行（anchor 已落不重复）+ 删行后可补偿', async () => {
    const session = await newSession()
    const done = cmdOf(session, { content: '完整一轮' })
    const s1 = makeService({ script: [new AIMessage({ content: [{ type: 'text', text: '完整回答。' }] })] })
    await s1.execute(done)
    expect(s1.stateOf(session)?.state).toBe('completed')
    const before = await projectionMessages(session)

    // processor 完成后 ack 前崩溃 → stalled 重放：checkpoint 判据命中（id=runId 已 append）→ recover no-op
    const s2 = makeService({ script: [] })
    await s2.execute(done)
    expect(s2.stateOf(session)?.state).toBe('completed')
    expect(await projectionMessages(session)).toEqual(before) // anchor 幂等防双行

    // 「图完未落行」形态（recordTurn 前崩溃）：删行后重放 → checkpointTurn 补聚合
    const lastRow = await prisma.sessionMessage.findFirst({
      where: { sessionId: session, role: 'assistant' },
      orderBy: { turn: 'desc' },
    })
    expect(lastRow).not.toBeNull()
    await prisma.sessionMessage.delete({ where: { id: lastRow!.id } })
    const s3 = makeService({ script: [] })
    await s3.execute(done)
    expect(s3.stateOf(session)?.state).toBe('completed')
    const after = await projectionMessages(session)
    expect(after.length).toBe(before.length)
    expect(after[after.length - 1].content).toContain('完整回答。')
  }, 30_000)

  it('abort-resume 崩溃重放：转 recover 后仍落 aborted 终态（abort 语义保留）', async () => {
    const session = await newSession()
    // resume 执行中崩溃（RESUME 已消费、工具已跑、工具回执后的模型轮抛错）——
    // 「无 pending interrupt 且 RESUME write 在」的重放前提
    const seed = makeService({
      interruptOnExecute: true,
      script: [
        toolCallAi('rec-c4', 'execute', { command: 'echo hi' }, '想想。'),
        () => {
          throw new Error('crash mid-resume')
        },
      ],
    })
    await seed.execute(cmdOf(session, { content: '待中止问题' }))
    expect(seed.stateOf(session)?.state).toBe('interrupted')
    const resumeCmd = cmdOf(session, {
      runId: 'rec-abort-1',
      kind: 'resume',
      decisions: { decisions: [{ type: 'approve' }] },
    })
    await seed.execute(resumeCmd)
    expect(seed.stateOf(session)?.state).toBe('failed')

    // 带 abort 的重放（用户在恢复面选择终止）：转 recover → null 续跑跑完 → aborted 终态
    const s2 = makeService({ script: [new AIMessage({ content: [{ type: 'text', text: '收尾。' }] })] })
    await s2.execute({ ...resumeCmd, abort: true })
    expect(s2.stateOf(session)?.state).toBe('aborted')
    expect(hub.types().lastIndexOf('run.aborted')).toBeGreaterThan(-1)
  }, 30_000)

  it('recover 续跑再 interrupted：常规 reducer 落行面（断点前内容缺位——已知边界锁定）', async () => {
    const session = await newSession()
    // 第一次审批 interrupt（AI 产出 execute tool_call 后停）
    const seed = makeService({
      interruptOnExecute: true,
      script: [toolCallAi('rec-i1', 'execute', { command: 'echo hi' }, '想想。')],
    })
    await seed.execute(cmdOf(session, { content: '二次审批问题' }))
    expect(seed.stateOf(session)?.state).toBe('interrupted')

    // resume 执行中崩溃（RESUME 已消费、error write 落盘）
    const resumeCmd = cmdOf(session, {
      runId: 'rec-resume-i1',
      kind: 'resume',
      decisions: { decisions: [{ type: 'approve' }] },
    })
    const crashed = makeService({
      interruptOnExecute: true,
      script: [
        () => {
          throw new Error('crash after resume')
        },
      ],
    })
    await crashed.execute(resumeCmd)
    expect(crashed.stateOf(session)?.state).toBe('failed')

    // 重放前模拟真实进程崩溃形态（finally 未执行、中途落行未发生）：删本 run 已落行，
    // 断点前内容只存在于 checkpoint blob
    await prisma.sessionMessage.deleteMany({ where: { sessionId: session, role: 'assistant' } })

    // 重放 → recover → null 续跑重试 AI 轮 → 产出第二个 tool_call → 再停 interrupt
    const s2 = makeService({
      interruptOnExecute: true,
      script: [toolCallAi('rec-i2', 'execute', { command: 'echo again' })],
    })
    await s2.execute(resumeCmd)
    expect(s2.stateOf(session)?.state).toBe('interrupted')
    // 现状锁定：interrupted 终态走常规 reducer 面——本次续跑只流出 tool_call（无 text.delta）
    // → 空聚合不落行。断点前内容（想想。+ 工具行，只在 blob）缺位（blob∪reducer 结构化合并
    // 归后续；纯串拼接在 interrupted 形态下 blob 与 reducer 前缀重叠必重影，故不做）
    expect((await projectionMessages(session)).filter((r) => r.role === 'assistant')).toHaveLength(0)

    // 缺口固化面：后续 resume 完成 → 落行只含 resume 段，断点前内容不在任何行
    const s3 = makeService({
      interruptOnExecute: true,
      script: [new AIMessage({ content: [{ type: 'text', text: '重试后回答。' }] })],
    })
    await s3.execute({ ...resumeCmd, runId: 'rec-resume-i2' })
    expect(s3.stateOf(session)?.state).toBe('completed')
    const rows = await projectionMessages(session)
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(1)
    expect(rows[rows.length - 1].content).toBe('重试后回答。')
  }, 30_000)

  // ---- story 11：inFlightProjection ----

  it('running 态从 checkpoint 重建 turn；终态 undefined', async () => {
    const session = await newSession()
    const s = makeService({
      slowExec: true,
      script: [
        toolCallAi('rec-c5', 'execute', { command: 'echo slow' }, '先想一下。'),
        new AIMessage({ content: [{ type: 'text', text: '慢回答。' }] }),
      ],
    })
    const running = s.execute(cmdOf(session, { content: '在飞问题', runId: 'rec-inflight-1' }))
    // 等 running 态 + checkpoint 出现工具行（慢工具窗口；thinking 面归 S3 纯逻辑用例——
    // runnerFakes 流式路径不产出 thinking 块，checkpoint 无其来源）
    let inflight: Awaited<ReturnType<typeof s.inFlightProjection>>
    await waitFor(async () => {
      inflight = await s.inFlightProjection(session)
      return (inflight?.turn.tools?.length ?? 0) > 0
    })
    expect(inflight?.state).toBe('running')
    expect(inflight?.runId).toBe('rec-inflight-1')
    // 断点前内容从 blob 重建（工具行）
    expect(inflight?.turn.tools?.[0]).toMatchObject({ toolCallId: 'rec-c5', name: 'execute' })
    await running

    // 终态 → undefined
    expect(await s.inFlightProjection(session)).toBeUndefined()
  }, 30_000)
})
