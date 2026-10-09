// #747 B 节 TextTrace 双域（R2 修复②）：recordTurn 落盘路径补 text_trace_logs 写——
// 「双域——mapper 写两份、代码不共享」（session_messages 产品读源 + text_trace_logs 合规
// provenance）。旧唯一写入面 WS 隧道 recordTextTrace 已随退役删除 → 对话域审计断档：
// tool_approval_logs.traceId（V1 = runId 占位，funnel identity）无 text_trace_logs 行可 join、
// trace-logs 查询路由对对话域永空。本文件锁 recordTurn 公共路径的双写口径。
//
// 接缝：recordTurn（RunService 注入缝的生产实现，sessions/service.ts）直调——真 SQLite
// 临时库（S3 先例：prismaCheckpointSaver.test.ts）+ 真 StreamHub；runService 依赖在
// recordTurn 路径零消费（ teammates 查 + publish 经 hub），stub 满足类型即可。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { runDbScript } from './runDbScript'
import { StreamHub } from '../src/events/hub'
import { SessionService, type SessionRunGateway } from '../src/sessions/service'

const OWNER_ID = 'owner-tt-1'

// recordTurn 路径零消费 runService（ teammates 查走 prisma、事件走 hub）——类型桩即可
const runServiceStub = {
  stateOf: () => undefined,
  abort: () => false,
  quotaFull: async () => false,
  buildMessageCommand: async () => { throw new Error('unused in recordTurn seam') },
  buildResumeCommand: () => { throw new Error('unused in recordTurn seam') },
  inFlightProjection: async () => undefined,
} as unknown as SessionRunGateway

describe('recordTurn 双域落盘（#747 B 节 · session_messages + text_trace_logs 各一行）', () => {
  let dbDir: string
  let prisma: PrismaClient
  let sessions: SessionService
  let sessionId: string

  beforeAll(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'record-turn-tt-test-'))
    const dbPath = path.join(dbDir, 'test.db')
    runDbScript('apply-schema.mjs', dbPath)
    prisma = createPrismaClient(`file:${dbPath}`)
    sessions = new SessionService({
      prisma,
      hub: new StreamHub(),
      runService: runServiceStub,
      dispatch: async () => {},
    })
    await prisma.user.create({ data: { id: OWNER_ID, username: 'tt-owner' } })
    const session = await prisma.session.create({
      data: { id: '', ownerId: OWNER_ID, containerId: '' },
    })
    sessionId = session.id
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('completed turn：session_messages assistant 行 + text_trace_logs 行各落一行，审计字段口径符合 B 节/ADR 0015', async () => {
    // 触发本轮的用户输入（recordTurn 的 inputText 来源——最新未归档 user 行）
    await prisma.sessionMessage.create({
      data: { sessionId, turn: 1, role: 'user', content: '用户的问题正文' },
    })

    await sessions.recordTurn({
      sessionId,
      runId: 'run-tt-1',
      anchorCheckpointId: '20261009-000000-tt-terminal',
      status: 'success', // run 终态 completed
      aggregate: { content: '助手的回答正文' },
    })

    // 域一：会话历史（产品读源）——assistant 行照常落（turn 接续 + 终态锚点）
    const message = await prisma.sessionMessage.findFirstOrThrow({
      where: { sessionId, role: 'assistant' },
    })
    expect(message.turn).toBe(2)
    expect(message.content).toBe('助手的回答正文')
    expect(message.anchorCheckpointId).toBe('20261009-000000-tt-terminal')

    // 域二：TextTrace 审计（合规 provenance）——traceId = runId（漏斗 V1 占位落实：
    // tool_approval_logs.traceId ← text_trace_logs.traceId 弱关联 join 面接通，schema
    // ToolApprovalLog.traceId 注释「#727 双域接缝」）；快照截断 20k（TRACE_TEXT_MAX）；
    // 服务端写面 ipAddress = 'internal'（file-journal/teammate-mail 先例）；跟 user 永久。
    const trace = await prisma.textTraceLog.findFirstOrThrow({
      where: { sessionKey: sessionId, runId: 'run-tt-1' },
    })
    expect(trace.traceId).toBe('run-tt-1')
    expect(trace.userId).toBe(OWNER_ID)
    expect(trace.username).toBe('tt-owner')
    expect(trace.ipAddress).toBe('internal')
    expect(trace.containerName).toBeNull()
    expect(trace.sessionKey).toBe(sessionId)
    expect(trace.runId).toBe('run-tt-1')
    expect(trace.inputText).toBe('用户的问题正文')
    expect(trace.outputText).toBe('助手的回答正文')
    expect(trace.outputHash).toBe(createHash('sha256').update('助手的回答正文', 'utf8').digest('hex'))
    expect(trace.status).toBe('success')
  })

  it('failed turn（终态锚缺失：aborted/failed 路径无可靠终态 state）→ status = failed，双域仍各落一行', async () => {
    await prisma.sessionMessage.create({
      data: { sessionId, turn: 3, role: 'user', content: '第二次提问' },
    })

    await sessions.recordTurn({
      sessionId,
      runId: 'run-tt-2',
      anchorCheckpointId: null, // aborted/failed：无可靠终态锚（runService 终态面恒 null）
      status: 'failed',
      aggregate: { content: '半截回答' },
    })

    const message = await prisma.sessionMessage.findFirstOrThrow({
      where: { sessionId, role: 'assistant', anchorCheckpointId: null },
    })
    expect(message.turn).toBe(4)
    const trace = await prisma.textTraceLog.findFirstOrThrow({
      where: { sessionKey: sessionId, runId: 'run-tt-2' },
    })
    expect(trace.traceId).toBe('run-tt-2')
    expect(trace.inputText).toBe('第二次提问')
    expect(trace.outputText).toBe('半截回答')
    expect(trace.status).toBe('failed')
  })

  // 修 1 回归（R3）：status 判定来源是「该轮 assistant generation 是否 completed」的终态语义，
  // 不是终态锚有无的推论。runService 在 interrupt 判定（runService.ts:1066）之前已从终态 state
  // 取锚（:1053）——interrupted 轮（审批升级场景）锚恒非空，旧「锚非空⇔success」映射把
  // 半成品行错标 success，与函数注释、本前提、schema.prisma「Each completed assistant
  // generation」三重矛盾。半成品 provenance 明确标 failed，不留成功假象。
  it('interrupted turn（审批升级场景）：终态锚非空（中断点 checkpoint 可靠存在）但 generation 未完成 → status = failed', async () => {
    await prisma.sessionMessage.create({
      data: { sessionId, turn: 5, role: 'user', content: '第三次提问（触发人工升级）' },
    })

    await sessions.recordTurn({
      sessionId,
      runId: 'run-tt-3',
      anchorCheckpointId: '20261009-000000-tt-interrupt', // interrupted：锚非空（终态推进先于 interrupt 判定）
      status: 'failed', // run 终态 interrupted ≠ completed
      aggregate: { content: '升级前已流出的半截输出' },
    })

    // 产品读源行不受影响：锚照落（rewind/resume 挂靠语义不变）——错标只发生在审计域 status。
    const message = await prisma.sessionMessage.findFirstOrThrow({
      where: { sessionId, role: 'assistant', anchorCheckpointId: '20261009-000000-tt-interrupt' },
    })
    expect(message.turn).toBe(6)
    const trace = await prisma.textTraceLog.findFirstOrThrow({
      where: { sessionKey: sessionId, runId: 'run-tt-3' },
    })
    expect(trace.traceId).toBe('run-tt-3')
    expect(trace.outputText).toBe('升级前已流出的半截输出')
    expect(trace.status).toBe('failed')
  })

  // suspended 同病补例（story 15：48h 升级超时，非终态挂起）——sweep 把 interrupted 推为
  // suspended 的窗口可在 executeRun 终态聚合期间落入，RecordTurnPayload.status 由 runService
  // 终态唯一判定：凡非 completed 一律 failed（suspended 的 generation 同样未完成）。
  it('suspended turn（48h 升级超时）：终态 suspended 非 completed → status = failed', async () => {
    await prisma.sessionMessage.create({
      data: { sessionId, turn: 7, role: 'user', content: '第四次提问（超时挂起）' },
    })

    await sessions.recordTurn({
      sessionId,
      runId: 'run-tt-4',
      anchorCheckpointId: '20261009-000000-tt-suspend',
      status: 'failed', // run 终态 suspended ≠ completed
      aggregate: { content: '超时前的半截输出' },
    })

    const trace = await prisma.textTraceLog.findFirstOrThrow({
      where: { sessionKey: sessionId, runId: 'run-tt-4' },
    })
    expect(trace.traceId).toBe('run-tt-4')
    expect(trace.outputText).toBe('超时前的半截输出')
    expect(trace.status).toBe('failed')
  })
})
