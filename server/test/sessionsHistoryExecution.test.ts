// #1079 · RF-T03 S1/S2/S4：真实只读执行进程 + 真实临时 SQLite + 真实 RunService 恢复链。
// 不以 fake executor 证明硬停止；不以 Promise.race 冒充终止。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import { setupTestApp, type TestContext } from './setup'
import { SessionHistoryService, type SessionHistoryOptions } from '../src/sessions/history/service'
import { ProcessHistoryReader } from '../src/sessions/history/executor'
import { PrismaHistoryLedger } from '../src/sessions/history/prismaLedger'
import { createHistoryAccessLogger } from '../src/sessions/history/logging'
import {
  HistoryCooperativeTimeout,
  HistoryExecutionTimeout,
  type HistoryContext,
  type HistoryReader,
} from '../src/sessions/history/model'
import { RunService } from '../src/runner/runtime/runService'
import { ProviderRegistry } from '../src/runner/providerRegistry'
import { PrismaCheckpointSaver } from '../src/runner/persistence/prismaCheckpointSaver'
import { ConcurrencyGate } from '../src/runner/concurrency'
import { ScriptedChatModel, fakePrimitives, CollectingHub, toolCallAi } from './runnerFakes'

describe('session_history 执行上限与主请求额度（RF-T03）', () => {
  let app: TestContext
  const context: HistoryContext = { ownerId: 't03-owner', currentSessionId: 't03-current', role: 'leader' }
  const other: HistoryContext = { ownerId: 't03-other', currentSessionId: 't03-other-current', role: 'leader' }
  const readers: Array<{ dispose(): void }> = []

  const dbPath = () => app.dbUrl.slice(5)
  const processReader = (options: Partial<ConstructorParameters<typeof ProcessHistoryReader>[0]> = {}) => {
    const reader = new ProcessHistoryReader({ dbPath: dbPath(), ...options })
    readers.push(reader)
    return reader
  }
  const service = (options: SessionHistoryOptions = {}, reader: HistoryReader = processReader()) =>
    new SessionHistoryService(reader, { cursorSweepMs: 0, ...options })

  beforeAll(async () => {
    app = await setupTestApp()
    await app.prisma.user.create({ data: { id: 't03-owner', username: 't03-owner', role: 'admin' } })
    await app.prisma.user.create({ data: { id: 't03-other', username: 't03-other' } })
    await app.prisma.session.create({ data: { id: 't03-current', ownerId: 't03-owner', containerId: 't03-current', title: '当前' } })
    await app.prisma.session.create({ data: { id: 't03-other-current', ownerId: 't03-other', containerId: 't03-other-current', title: '其他当前' } })
    await app.prisma.session.create({ data: { id: 't03-past', ownerId: 't03-owner', containerId: 't03-past', title: '过去的实验' } })
    await app.prisma.session.create({ data: { id: 't03-past2', ownerId: 't03-owner', containerId: 't03-past2', title: '第二个历史' } })
    for (const [id, text] of [['t03-past', '实验采用 A 方案'], ['t03-past2', '第二个历史记录']] as const) {
      await app.prisma.sessionMessage.create({ data: { id: `${id}-m1`, sessionId: id, turn: 1, role: 'assistant', content: text } })
    }
    // 分页用例：两条消息足以在 pageItems=1 时产生续读书签。
    await app.prisma.session.create({ data: { id: 't03-paging', ownerId: 't03-owner', containerId: 't03-paging', title: '分页' } })
    for (const turn of [1, 2]) {
      await app.prisma.sessionMessage.create({ data: { id: `t03-paging-m${turn}`, sessionId: 't03-paging', turn, role: 'assistant', content: `分页 ${turn}` } })
    }
  }, 30_000)

  afterEach(() => {
    while (readers.length) readers.pop()!.dispose()
  })
  afterAll(async () => { await app.cleanup() })

  // ---------- B4 / B5 / B6：真实执行进程、只读连接、协作时限与硬终止 ----------

  it('B4/M6：独立执行进程只读打开可信 SQLite 路径，真实搜索可用', async () => {
    const reader = processReader()
    expect(await reader.probeReadOnly()).toBe(true)
    const history = service({}, reader)
    const result = await history.execute(context, { operation: 'search', query: { text: '实验' } })
    expect(result).toMatchObject({ outcome: 'success', count: { unit: 'hits', value: 1 } })
    expect(result.groups[0]?.messages?.[0]).toMatchObject({ message_id: 't03-past-m1' })
    // 执行器故障不泄露宿主路径/SQL/堆栈。
    const broken = new ProcessHistoryReader({ dbPath: '/private/tmp/t03-secret-should-not-leak.db' })
    readers.push(broken)
    const failureResult = await new SessionHistoryService(broken, { cursorSweepMs: 0 }).execute(context, { operation: 'search' })
    expect(failureResult).toMatchObject({ outcome: 'failure', error: { category: 'system' } })
    expect(JSON.stringify(failureResult)).not.toMatch(/t03-secret|SELECT|stack|SQLITE|private/)
  }, 20_000)

  it('P18：正式精简访问日志无 query/正文/书签', async () => {
    const lines: string[] = []
    const history = new SessionHistoryService(processReader(), {
      cursorSweepMs: 0,
      events: createHistoryAccessLogger({ info: line => lines.push(line), warn: () => {} }),
    })
    const result = await history.execute(context, { operation: 'search', query: { text: '实验' } })
    expect(result.outcome).toBe('success')
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('实验')
    expect(lines[0]).not.toContain(result.cursor ?? '__no_cursor__')
    expect(lines[0]).toContain('"operation":"search"')
    expect(lines[0]).toContain('"category":"success"')
  }, 20_000)

  it('B5：协作超时立即停止，硬超时由执行进程真实终止且随后可复用', async () => {
    // 硬停止证明的是「到时限即 SIGKILL 且 reject」，不依赖宿主机调度精度：阈值放宽到 15s，
    // 避免全量并行负载下 spawn/IPC 抖动造成假红。
    const reader = processReader({ hardMs: 1_000 })
    const started = Date.now()
    await expect(reader.probeBusy(60_000, { cooperativeMs: 60_000, hardMs: 1_000 })).rejects.toBeInstanceOf(HistoryExecutionTimeout)
    expect(Date.now() - started).toBeLessThan(15_000)
    // 硬终止后执行进程退出；后续请求重新拉起子进程并成功（证明不是假停/挂死）。
    expect(await reader.probeReadOnly()).toBe(true)
  }, 30_000)

  it('B6：取消立即终止执行并释放执行槽，迟到结果不交付', async () => {
    const reader = processReader({ hardMs: 20_000 })
    const controller = new AbortController()
    const started = Date.now()
    const pending = reader.probeBusy(30_000, { cooperativeMs: 30_000, hardMs: 20_000, signal: controller.signal })
      .then(() => 'resolved' as const, (error: unknown) => error)
    setTimeout(() => controller.abort(), 100)
    const outcome = await pending
    // 取消路径真实终止子进程（协作超时类错误），不等硬停止。
    expect(outcome).toBeInstanceOf(HistoryCooperativeTimeout)
    expect(Date.now() - started).toBeLessThan(5_000)
    // 槽位已释放、子进程已退出：同一执行器可立即重新查询。
    const history = service({}, reader)
    expect(await history.execute(context, { operation: 'search', query: { text: '实验' } }))
      .toMatchObject({ outcome: 'success' })
    // 预先取消：服务层直接拒绝，不占槽。
    const preAborted = new AbortController()
    preAborted.abort()
    expect(await history.execute(context, { operation: 'search' }, preAborted.signal))
      .toMatchObject({ outcome: 'failure', error: { code: 'cancelled' } })
  }, 30_000)

  it('B11/M8/M9：每用户 1、全局 4 执行槽；满额立即 busy 不排队；dispose 释放资源', async () => {
    const reader = processReader({ maxGlobal: 2, maxPerUser: 1 })
    const history = service({}, reader)
    const lease = reader.executionLease(context)
    expect(lease).toBeDefined()
    // 同一用户第二槽 → busy（无排队）。
    expect(reader.executionLease(context)).toBeUndefined()
    expect(await history.execute(context, { operation: 'search' })).toMatchObject({ outcome: 'failure', error: { code: 'busy' } })
    // 其他用户占用剩余全局槽后，第三用户（不同 owner）满额 busy。
    const otherLease = reader.executionLease(other)
    expect(otherLease).toBeDefined()
    const third: HistoryContext = { ownerId: 't03-third', currentSessionId: 't03-third-current', role: 'leader' }
    expect(reader.executionLease(third)).toBeUndefined()
    lease!.release()
    expect(reader.executionLease(third)).toBeDefined()
    otherLease!.release()
    // dispose 后不再发槽。
    reader.dispose()
    expect(reader.executionLease(context)).toBeUndefined()
  }, 20_000)

  it('B20/M9：重启旧书签失效；书签状态归服务级注册表而非执行进程', async () => {
    const reader = processReader()
    const first = service({ pageItems: 1 }, reader)
    const page = await first.execute(context, { operation: 'read', targets: [{ session_id: 't03-paging' }] })
    expect(page.cursor).toEqual(expect.any(String))
    const restarted = service({ pageItems: 1 }, reader)
    expect(await restarted.execute(context, { operation: 'read', targets: [{ session_id: 't03-paging' }], cursor: page.cursor }))
      .toMatchObject({ outcome: 'failure', error: { code: 'invalid_cursor' } })
  }, 20_000)

  it('B21：1000 消息真实扫描在协作时限内完成，预算不可达不静默放宽', async () => {
    const session = 't03-bulk'
    await app.prisma.session.create({ data: { id: session, ownerId: 't03-owner', containerId: session, title: '批量' } })
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      id: `${session}-m${i + 1}`, sessionId: session, turn: i + 1, role: i % 2 ? 'assistant' : 'user', content: `条目 ${i + 1}`,
    }))
    await app.prisma.sessionMessage.createMany({ data: rows })
    const history = service()
    const started = Date.now()
    const result = await history.execute(context, { operation: 'search', session_ids: [session], query: { text: '条目 999' }, context: { before: 0, after: 0 } })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(result).toMatchObject({ outcome: 'success', progress: 'complete' })
    expect(result.groups[0]?.messages?.[0]).toMatchObject({ message_id: `${session}-m999` })
    // 单次输出上限最大 64KiB：即便配置更大也不得突破（I2）。
    const capped = new SessionHistoryService(processReader(), { maxResponseBytes: 1024 * 1024, cursorSweepMs: 0 })
    const read = await capped.execute(context, { operation: 'read', targets: [{ session_id: session }] })
    expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(64 * 1024)
    expect(read.progress).not.toBe('complete')
  }, 30_000)

  // ---------- B12 / B19 / G6：主请求额度、恢复延续与剩余额度优先 ----------

  it('B12：每主请求 10 次/30s/256KiB 含失败与重试；恢复延续不重新发放', async () => {
    const ledger = new PrismaHistoryLedger(app.prisma)
    const reader = processReader()
    const history = new SessionHistoryService(reader, { budget: ledger, cursorSweepMs: 0, requestMaxCalls: 3 })
    const requestId = await ledger.startMessageRequest({ kind: 'message', runId: 'run-1', ownerId: context.ownerId, sessionId: context.currentSessionId, triggerMessageId: 't03-trigger' })
    expect(requestId).toBe('t03-trigger')
    const ctx = { ...context, requestId: requestId! }
    // 两次合法调用 + 一次参数失败（失败也计入）。
    expect(await history.execute(ctx, { operation: 'search', query: { text: '实验' } })).toMatchObject({ outcome: 'success' })
    expect(await history.execute(ctx, { operation: 'search', query: { text: '不存在' } })).toMatchObject({ outcome: 'success' })
    await history.execute(ctx, { operation: 'bogus' })
    // 第 4 次：次数用尽。
    expect(await history.execute(ctx, { operation: 'search' })).toMatchObject({ outcome: 'failure', error: { code: 'request_budget' } })
    // 新实例（模型/图重建）沿用同一账本，不重置。
    const rebuilt = new SessionHistoryService(processReader(), { budget: ledger, cursorSweepMs: 0, requestMaxCalls: 3 })
    expect(await rebuilt.execute(ctx, { operation: 'search' })).toMatchObject({ outcome: 'failure', error: { code: 'request_budget' } })
    const row = await app.prisma.historyRequestBudget.findUnique({ where: { requestId: 't03-trigger' } })
    expect(row?.calls).toBe(5)
  }, 30_000)

  it('B19：剩余额度优先于单次上限，交付前计量且不超额', async () => {
    const ledger = new PrismaHistoryLedger(app.prisma)
    const history = new SessionHistoryService(processReader(), { budget: ledger, cursorSweepMs: 0, requestMaxBytes: 4_096 })
    const requestId = await ledger.startMessageRequest({ kind: 'message', runId: 'run-2', ownerId: context.ownerId, sessionId: context.currentSessionId, triggerMessageId: 't03-trigger-2' })
    const ctx = { ...context, requestId: requestId! }
    const first = await history.execute(ctx, { operation: 'read', targets: [{ session_id: 't03-past' }] })
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(4_096)
    const row = await app.prisma.historyRequestBudget.findUnique({ where: { requestId: 't03-trigger-2' } })
    expect(row!.returnedBytes).toBeGreaterThan(0)
    // 剩余额度不足时明确拒绝，不先超额再计数。
    for (let i = 0; i < 30; i++) {
      const next = await history.execute(ctx, { operation: 'read', targets: [{ session_id: 't03-past' }] })
      if (next.error?.code === 'request_budget' || next.error?.code === 'response_limit') break
      expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(4_096)
    }
    const final = await history.execute(ctx, { operation: 'read', targets: [{ session_id: 't03-past' }] })
    expect(['request_budget', 'response_limit']).toContain(final.error?.code)
  }, 30_000)

  it('G6/G7：稳定主请求身份 ≠ runId，审批恢复延续同一账本；不同用户互不共享', async () => {
    const ledger = new PrismaHistoryLedger(app.prisma)
    const contexts: HistoryContext[] = []
    const history = {
      execute: async (ctx: HistoryContext) => {
        contexts.push(ctx)
        return { outcome: 'success' as const, progress: 'complete' as const, groups: [], count: { unit: 'sessions' as const, value: 0 }, guidance: '' }
      },
      resolveRunRequest: (input: Parameters<PrismaHistoryLedger['resolveRunRequest']>[0]) => ledger.resolveRunRequest(input),
    }
    const svc = new RunService({
      prisma: app.prisma,
      registry: new ProviderRegistry(app.prisma, {
        llmApiKey: 'test-key',
        modelFactory: async () => new ScriptedChatModel([
          toolCallAi('h1', 'session_history', { operation: 'search', query: { text: '实验' } }),
          new AIMessage('已检索。'),
        ]),
      }),
      saver: new PrismaCheckpointSaver(app.prisma),
      gate: new ConcurrencyGate({ globalLimit: 8, loadUserLimit: async () => 4 }),
      hub: new CollectingHub(),
      primitives: fakePrimitives().primitives,
      resolveWikiContainer: () => 'wiki',
      sweepIntervalMs: 0,
      interruptPolicyFor: sessionId => sessionId === 't03-g6' ? { tools: ['session_history'] } : undefined,
      history,
    })
    const sessionId = 't03-g6'
    await app.prisma.session.create({ data: { id: sessionId, ownerId: 't03-owner', containerId: sessionId } })
    await app.prisma.sessionMessage.create({ data: { id: 't03-g6-msg', sessionId, turn: 1, role: 'user', content: '找历史' } })
    await svc.execute({ runId: 'g6-run-1', sessionId, ownerId: 't03-owner', username: 't03-owner', kind: 'message', content: '找历史', triggerMessageId: 't03-g6-msg' })
    // 图内工具被 interrupt 策略挡在 execute 前——不执行；但历史身份在 run 前已解析。
    const resume = svc.buildResumeCommand({ sessionId, ownerId: 't03-owner', username: 't03-owner', decisions: { decisions: [{ type: 'approve' }] } })
    await svc.execute(resume)
    // G7：另一用户的主请求走自己的账本，不共享身份/额度。
    const otherSession = 't03-g7'
    await app.prisma.session.create({ data: { id: otherSession, ownerId: 't03-other', containerId: otherSession } })
    await app.prisma.sessionMessage.create({ data: { id: 't03-g7-msg', sessionId: otherSession, turn: 1, role: 'user', content: '他的历史' } })
    await svc.execute({ runId: 'g7-run', sessionId: otherSession, ownerId: 't03-other', username: 't03-other', kind: 'message', content: '他的历史', triggerMessageId: 't03-g7-msg' })
    svc.dispose()
    const requestIds = contexts.map(c => c.requestId)
    expect(requestIds.filter(id => id === 't03-g6-msg').length).toBeGreaterThanOrEqual(1)
    expect(contexts.filter(c => c.ownerId === 't03-owner').every(c => c.requestId === 't03-g6-msg')).toBe(true)
    expect(contexts.filter(c => c.ownerId === 't03-other').map(c => c.requestId)).toEqual(['t03-g7-msg'])
    const row = await app.prisma.historyRequestBudget.findUnique({ where: { requestId: 't03-g6-msg' } })
    // resume 的 runId 不同（≠ 主请求身份），账本仍挂 triggerMessageId。
    expect(row).not.toBeNull()
    expect(row!.lastRunId).toBe(resume.runId)
    expect(row!.lastRunId).not.toBe('g6-run-1')
    const otherRow = await app.prisma.historyRequestBudget.findUnique({ where: { requestId: 't03-g7-msg' } })
    expect(otherRow).toMatchObject({ ownerId: 't03-other', sessionId: otherSession })
  }, 30_000)

  it('G8/G9：限额停止状态由真实执行路径产生并经工具回喂可解释，附出处', async () => {
    const model = new ScriptedChatModel([
      toolCallAi('h2', 'session_history', { operation: 'read', targets: [{ session_id: 't03-g8-bulk' }] }),
      new AIMessage('检索达到时限未完成；已读部分来自《大历史》，不是完整历史。'),
    ])
    const ledger = new PrismaHistoryLedger(app.prisma)
    const historyService = new SessionHistoryService(processReader(), {
      budget: ledger, cooperativeMs: 1, cursorSweepMs: 0,
    })
    const svc = new RunService({
      prisma: app.prisma,
      registry: new ProviderRegistry(app.prisma, { llmApiKey: 'test-key', modelFactory: async () => model }),
      saver: new PrismaCheckpointSaver(app.prisma),
      gate: new ConcurrencyGate({ globalLimit: 8, loadUserLimit: async () => 4 }),
      hub: new CollectingHub(),
      primitives: fakePrimitives().primitives,
      resolveWikiContainer: () => 'wiki',
      sweepIntervalMs: 0,
      history: {
        execute: (ctx, input, signal) => historyService.execute(ctx, input, signal),
        resolveRunRequest: input => ledger.resolveRunRequest(input),
        requiresRequestIdentity: true,
      },
    })
    await app.prisma.session.create({ data: { id: 't03-g8-bulk', ownerId: 't03-owner', containerId: 't03-g8-bulk', title: '大历史' } })
    await app.prisma.sessionMessage.create({ data: { id: 't03-g8-m1', sessionId: 't03-g8-bulk', turn: 1, role: 'assistant', content: '内容 '.repeat(500) } })
    const sessionId = 't03-g8'
    await app.prisma.session.create({ data: { id: sessionId, ownerId: 't03-owner', containerId: sessionId } })
    await app.prisma.sessionMessage.create({ data: { id: 't03-g8-msg', sessionId, turn: 1, role: 'user', content: '继续查历史' } })
    await svc.execute({ runId: 'g8-run', sessionId, ownerId: 't03-owner', username: 't03-owner', kind: 'message', content: '继续查历史', triggerMessageId: 't03-g8-msg' })
    svc.dispose()
    historyService.dispose()
    const transcript = JSON.stringify(model.receivedMessages)
    // 工具结果以序列化 JSON 回喂：真实执行路径产生的协议状态与出处字段必须完整可解释。
    expect(transcript).toContain('\\"progress\\":\\"stopped\\"')
    expect(transcript).toContain('\\"code\\":\\"timeout\\"')
    expect(transcript).toContain('t03-g8-bulk')
    expect(transcript).toContain('大历史')
  }, 30_000)

  it('G6：resume 找不到持久账本时停止增强，不重新发放额度', async () => {
    const ledger = new PrismaHistoryLedger(app.prisma)
    const seen: (string | undefined)[] = []
    const svc = new RunService({
      prisma: app.prisma,
      registry: new ProviderRegistry(app.prisma, {
        llmApiKey: 'test-key',
        modelFactory: async () => new ScriptedChatModel([new AIMessage('没有历史工具也可以继续。')]),
      }),
      saver: new PrismaCheckpointSaver(app.prisma),
      gate: new ConcurrencyGate({ globalLimit: 8, loadUserLimit: async () => 4 }),
      hub: new CollectingHub(),
      primitives: fakePrimitives().primitives,
      resolveWikiContainer: () => 'wiki',
      sweepIntervalMs: 0,
      history: {
        execute: async (ctx) => {
          seen.push(ctx.requestId)
          return { outcome: 'success' as const, progress: 'complete' as const, groups: [], count: { unit: 'sessions' as const, value: 0 }, guidance: '' }
        },
        resolveRunRequest: (input) => ledger.resolveRunRequest(input),
        requiresRequestIdentity: true,
      },
    })
    const sessionId = 't03-g6b'
    await app.prisma.session.create({ data: { id: sessionId, ownerId: 't03-owner', containerId: sessionId } })
    await svc.execute({ runId: 'g6b-1', sessionId, ownerId: 't03-owner', username: 't03-owner', kind: 'message', content: 'hi' })
    svc.dispose()
    // 无 triggerMessageId、无账本行：不创建新账本。
    expect(await app.prisma.historyRequestBudget.count({ where: { sessionId } })).toBe(0)
    expect(seen).toEqual([])
  }, 30_000)
})
