// S1 信封级集成（#785 · #747 E 节锁方案）：真 RunService + 临时 SQLite + fakePrimitives +
// ScriptedChatModel——锁超时 {error} 回喂 agent（报 path 与持有者、run 不失败）/ abort 持锁
// 自动释放 / write-after-write 覆盖审计一次落 file_overwrite_logs（同 thread 静默）。

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
import { WriteLockRegistry } from '../src/runner/writelock/registry'
import type { SandboxFilePrimitives } from '../src/runner/backend/primitives'
import { seedUser } from './helpers'
import { ScriptedChatModel, fakePrimitives, CollectingHub, toolCallAi, type ScriptEntry } from './runnerFakes'
import { installAbortRejectionGuard } from '../src/runner/runtime/abortGuard'

const WIKI = 'researcher-wiki-u1'
const LAB = 'researcher-sandbox-s1'

interface ToolEndPayload {
  toolCallId: string
  name: string
  state: 'success' | 'error'
  details: string
}

describe('RunService 写锁与覆盖审计（S1，#785）', () => {
  let prisma: PrismaClient
  let hub: CollectingHub
  let owner: { id: string; username: string }
  const sessionId = 'sess-1'
  let currentScript: ScriptEntry[]

  beforeAll(async () => {
    // abort 用例会触发 LangGraph abortPromise 泄漏（abortGuard.ts 头注）——测试进程同款守门
    installAbortRejectionGuard()
    const dir = mkdtempSync(path.join(tmpdir(), 'runner-writelock-'))
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma, 'writelock-user1', 'pw-writelock-secure')
    owner = { id: user.id, username: user.username }
    await prisma.session.create({
      data: { id: sessionId, ownerId: user.id, containerId: LAB, title: '' },
    })
    await prisma.modelProvider.create({
      data: {
        ownerId: user.id,
        providerId: 'prov-1',
        presetId: 'openai',
        modelsJson: JSON.stringify([{ id: 'model-x' }]),
      },
    })
    hub = new CollectingHub()
  }, 30_000)

  afterAll(async () => {
    await prisma.$disconnect()
  })

  afterEach(async () => {
    hub.reset()
    currentScript = []
    await prisma.fileOverwriteLog.deleteMany({})
    await prisma.fileJournal.deleteMany({})
    await prisma.checkpoint.deleteMany({})
    await prisma.session.deleteMany({ where: { isTeammate: true } })
  })

  // 每用例独立 RunService（独立 registry → 独立脚本模型——同 runnerRunService.test.ts 纪律）。
  function makeService(
    opts: {
      script?: ScriptEntry[]
      writeLocks?: WriteLockRegistry
      primitives?: SandboxFilePrimitives
    } = {},
  ): RunService {
    const script = opts.script ?? currentScript
    const registry = new ProviderRegistry(prisma, {
      llmApiKey: 'test-key',
      modelFactory: async () => new ScriptedChatModel(script),
    })
    return new RunService({
      prisma,
      registry,
      saver: new PrismaCheckpointSaver(prisma),
      gate: new ConcurrencyGate({ globalLimit: 8, loadUserLimit: async () => 4 }),
      hub,
      primitives: opts.primitives ?? fakePrimitives().primitives,
      resolveWikiContainer: () => WIKI,
      ...(opts.writeLocks ? { writeLocks: opts.writeLocks } : {}),
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
      content: '写一下文件',
      ...p,
    }
  }

  const writeTool = (path: string): ScriptEntry[] => [
    toolCallAi('c1', 'write_file', { file_path: path, content: 'hi' }),
    new AIMessage({ content: '写好了。' }),
  ]

  it('锁超时：tool 结果回喂 agent 且含 path 与持有者，run 不失败；释放后重试成功', async () => {
    const f = fakePrimitives()
    const locks = new WriteLockRegistry({ timeoutMs: 60 })
    const svc = makeService({ script: writeTool('/lab/notes/a.txt'), writeLocks: locks, primitives: f.primitives })
    // 外部（模拟另一 teammate run）先持锁同 path——互斥域 = 会话
    const external = await locks.acquire(sessionId, 'lab/notes/a.txt', {
      label: 'teammate run r-other（thread t2）',
      runId: 'r-other',
    })
    try {
      await svc.execute(cmd())
      expect(hub.types()).toContain('run.completed') // 锁错误是 tool 结果面，非 run.failed
      const end = hub.events
        .filter((e) => e.type === 'tool.end')
        .map((e) => e.payload as ToolEndPayload)
        .find((p) => p.name === 'write_file')
      // 报 path 与持有者（#769 锁方案验收面：agent 自行决策重试/换路径）；deepagents 把
      // backend {error} 文案作为 tool 输出回喂（ToolMessage status 缺省——projector 注释锁定）
      expect(end?.details).toContain('/lab/notes/a.txt')
      expect(end?.details).toContain('teammate run r-other')
      expect(f.trees.get(LAB)?.has('/lab/notes/a.txt') ?? false).toBe(false) // 被挡写未落盘
      expect(locks.held()).toHaveLength(1) // 仅外部持有者——run 的锁已随 op 释放
    } finally {
      external.release()
    }
    // 释放后重试：同一把锁立即取得、写入落盘、run completed（hub 清空——只看重试轮事件）
    hub.reset()
    const svc2 = makeService({ script: writeTool('/lab/notes/a.txt'), writeLocks: locks, primitives: f.primitives })
    await svc2.execute(cmd())
    expect(hub.types()[hub.types().length - 1]).toBe('run.completed')
    const okEnd = hub.events
      .filter((e) => e.type === 'tool.end')
      .map((e) => e.payload as ToolEndPayload)
      .find((p) => p.name === 'write_file')
    expect(okEnd?.details).not.toContain('is locked by')
    expect((f.trees.get(LAB)?.get('/lab/notes/a.txt') as Buffer).toString()).toBe('hi')
    expect(locks.held()).toEqual([])
  })

  it('持锁者死亡随 task 取消自动释放：abort run 中持锁写入 → 终态后锁可立即获取', async () => {
    // putArchive 门闩：把 backend.write 阻在锁持有窗口内，模拟慢写/争用现场
    const f = fakePrimitives()
    let openGate: () => void = () => {}
    const gate = new Promise<void>((r) => {
      openGate = r
    })
    const primitives: SandboxFilePrimitives = {
      exec: (c, cmd_, o) => f.primitives.exec(c, cmd_, o),
      getArchive: (c, p) => f.primitives.getArchive(c, p),
      putArchive: async (c, d, t) => {
        await gate
        return f.primitives.putArchive(c, d, t)
      },
    }
    const locks = new WriteLockRegistry({ timeoutMs: 5000 })
    const svc = makeService({ script: writeTool('/lab/gate.txt'), writeLocks: locks, primitives })
    const command = cmd()
    const running = svc.execute(command)
    // 等待锁被本 run 持有（backend.write 已进入锁窗口）
    for (let i = 0; i < 200 && !locks.held().some((h) => h.path === 'lab/gate.txt'); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(locks.held().some((h) => h.path === 'lab/gate.txt')).toBe(true)
    expect(svc.abort(command.runId, 'user')).toBe(true)
    openGate()
    await running
    expect(hub.types()).toContain('run.aborted')
    // 取消即释放（releaseRun 兜底 + 包装层 finally）：探针立即取得
    const probe = await locks.acquire(sessionId, 'lab/gate.txt', { label: 'probe' })
    probe.release()
    expect(locks.held()).toEqual([])
  })

  it('write-after-write 覆盖审计：上家 writer ≠ 本 thread → 记一次（多行只记最新上家）', async () => {
    // teammate thread t2 的 checkpoint + 同 path 两条 applied journal 行（跨 thread 上家）
    await prisma.session.create({
      data: { id: 't2', ownerId: owner.id, containerId: LAB, title: '', isTeammate: true },
    })
    await prisma.checkpoint.create({
      data: { threadId: 't2', checkpointNs: '', checkpointId: 'cp-t2', type: 'json', blob: Buffer.alloc(0) },
    })
    for (const [seq, op, tc] of [
      [1, 'write', 'tc-1'],
      [2, 'edit', 'tc-2'],
    ] as const) {
      await prisma.fileJournal.create({
        data: { sessionId, checkpointId: 'cp-t2', seq, op, path: 'lab/notes/a.txt', toolCallId: tc, applied: true },
      })
    }
    const svc = makeService({ script: writeTool('/lab/notes/a.txt') })
    await svc.execute(cmd())
    const rows = await prisma.fileOverwriteLog.findMany()
    expect(rows).toHaveLength(1) // 一次写 op 至多一行（上家只取最新 applied 行）
    expect(rows[0]).toMatchObject({
      sessionId,
      path: 'lab/notes/a.txt',
      overwriterThreadId: sessionId,
      overwrittenThreadId: 't2',
    })
    expect(rows[0]?.runId).toBeTruthy()
  })

  it('覆盖审计本 thread 静默：上家 writer = 本 thread（fork 继承形态）不记', async () => {
    await prisma.checkpoint.create({
      data: { threadId: sessionId, checkpointNs: '', checkpointId: 'cp-t1', type: 'json', blob: Buffer.alloc(0) },
    })
    await prisma.fileJournal.create({
      data: { sessionId, checkpointId: 'cp-t1', seq: 1, op: 'write', path: 'lab/quiet.txt', toolCallId: 'tc-1', applied: true },
    })
    const svc = makeService({ script: writeTool('/lab/quiet.txt') })
    await svc.execute(cmd())
    expect(await prisma.fileOverwriteLog.count()).toBe(0)
  })
})
