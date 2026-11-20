import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createMiddleware } from 'langchain'
import { HumanMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { PrismaClient, BackgroundExec } from '../../generated/prisma/client'
import { NameSerializer } from '../../containers/lifecycleQueue'
import { CODE } from '../../codes'
import { fail } from '../../envelope'
import type { EventPublisher, RunCommand } from '../runtime/runService'
import { currentToolCallContext } from '../filejournal/context'
import type { SandboxBackendProtocolV2 } from '../backend/protocol'
import type { BackgroundRuntime, ProcessSpec } from './dockerRuntime'
import { activeStates, EXEC_QUERY_TOOL, EXEC_RESULT_CHARS, type ExecSettings } from './values'

const context = new AsyncLocalStorage<{ cmd: RunCommand; signal: AbortSignal }>()
export function withBackgroundRun<T>(cmd: RunCommand, signal: AbortSignal, fn: () => T): T { return context.run({ cmd, signal }, fn) }
export function resultMessageId(id: string): string { return `background-result-${id}` }

export class BackgroundExecService {
  private readonly locks = new NameSerializer()
  private timer?: NodeJS.Timeout
  private ticking = false
  private wake?: (tasks: BackgroundExec[]) => Promise<void>

  constructor(readonly prisma: PrismaClient, private readonly runtime: BackgroundRuntime,
    private readonly settings: ExecSettings, private readonly hub: EventPublisher,
    private readonly touch: (sessionId: string) => void = () => {}) {}

  start(wake: (tasks: BackgroundExec[]) => Promise<void>): void {
    this.wake = wake
    this.timer = setInterval(() => { void this.tick().catch(e => console.error('[background-exec]', e)) }, this.settings.pollMs)
    this.timer.unref()
    void this.tick().catch(e => console.error('[background-exec] recovery', e))
  }
  close(): void { clearInterval(this.timer) }
  private spec(row: BackgroundExec): ProcessSpec {
    return { id: row.id, command: row.command, container: row.container, hardTimeoutMs: row.hardTimeoutMs, logBytes: row.logBytes }
  }
  private changed(row: BackgroundExec): void {
    this.hub.publish(row.ownerId, { type: 'background_exec.updated', sessionId: row.sessionId, payload: { taskId: row.id } })
  }
  async authorize(ownerId: string, sessionId: string): Promise<void> {
    if (!await this.prisma.session.findFirst({ where: { id: sessionId, ownerId, archivedAt: null } })) throw fail(CODE.SESSION_NOT_FOUND)
  }
  async list(ownerId: string, sessionId: string) {
    await this.authorize(ownerId, sessionId)
    const rows = await this.prisma.backgroundExec.findMany({ where: { sessionId, ownerId, background: true }, orderBy: { createdAt: 'desc' },
      select: { id: true, threadId: true, runId: true, command: true, state: true, delivery: true, exitCode: true,
        truncated: true, createdAt: true, finishedAt: true, updatedAt: true } })
    const teammates = await this.prisma.teammate.findMany({ where: { parentSessionId: sessionId }, select: { threadId: true, name: true } })
    const names = new Map(teammates.map(t => [t.threadId, t.name]))
    return rows.map(row => ({ ...row, executorName: row.threadId === sessionId ? '主助手' : names.get(row.threadId) ?? '协作者' }))
  }
  async output(ownerId: string, sessionId: string, id: string, offset = 0, limit = 16_384) {
    await this.authorize(ownerId, sessionId)
    const row = await this.prisma.backgroundExec.findFirst({ where: { id, ownerId, sessionId } })
    if (!row) throw fail(CODE.SESSION_NOT_FOUND)
    return { id, state: row.state, exitCode: row.exitCode, delivery: row.delivery, truncated: row.truncated,
      stdout: row.stdout.slice(offset, offset + limit), stderr: row.stderr.slice(offset, offset + limit),
      nextOffset: offset + limit < Math.max(row.stdout.length, row.stderr.length) ? offset + limit : null }
  }
  async execute(cmd: RunCommand, container: string, toolCallId: string, command: string): Promise<string> {
    const sessionId = cmd.parentSessionId ?? cmd.sessionId
    const id = createHash('sha256').update(`${cmd.sessionId}:${cmd.runId}:${toolCallId}`).digest('hex')
    let row = await this.locks.enqueue(sessionId, async () => {
      if (context.getStore()?.signal.aborted) throw new Error('Execution cancelled')
      const existing = await this.prisma.backgroundExec.findUnique({ where: { id } })
      if (existing) return existing
      const count = await this.prisma.backgroundExec.count({ where: { sessionId, state: { in: activeStates } } })
      if (count >= this.settings.maxActive) throw new Error(`最多同时执行 ${this.settings.maxActive} 个 Shell 任务，请先查询已有任务。`)
      const task = await this.prisma.backgroundExec.create({ data: {
        id, sessionId, threadId: cmd.sessionId, ownerId: cmd.ownerId, runId: cmd.runId, toolCallId, command, container,
        createdAt: new Date(), runCommandJson: JSON.stringify(cmd), hardTimeoutMs: this.settings.hardTimeoutMs, logBytes: this.settings.logBytes,
      } })
      this.touch(sessionId)
      try { await this.runtime.start(this.spec(task)) }
      catch (e) {
        // The daemon may have accepted a detached exec before the connection failed.
        // Keep its durable identity visible; reconciliation must never invent a second command.
        const uncertain = await this.prisma.backgroundExec.update({ where: { id }, data: { background: true, stderr: `正在核对启动结果：${String(e).slice(0, 1000)}` } })
        this.changed(uncertain)
        return uncertain
      }
      return this.prisma.backgroundExec.update({ where: { id }, data: { state: 'running' } })
    })
    const deadline = row.createdAt.getTime() + this.settings.foregroundMs
    while (activeStates.includes(row.state) && Date.now() < deadline && row.delivery !== 'suppressed') {
      await delay(Math.min(this.settings.pollMs, Math.max(1, deadline - Date.now())))
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          this.refresh(row),
          new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(1, deadline - Date.now())) }),
        ])
      } catch (e) {
        row = await this.prisma.backgroundExec.update({ where: { id }, data: { background: true } })
        this.changed(row)
        console.error(`[background-exec] foreground observation ${id}`, e)
        break
      } finally { clearTimeout(timer) }
      row = await this.prisma.backgroundExec.findUniqueOrThrow({ where: { id } })
    }
    if (activeStates.includes(row.state)) {
      row = await this.prisma.backgroundExec.update({ where: { id }, data: { background: true } })
      this.changed(row)
      return JSON.stringify({ taskId: id, state: row.state, background: true,
        message: `命令仍在后台运行，继续其他工作；完成结果将自动送达。可使用 ${EXEC_QUERY_TOOL} 查询状态和输出。` })
    }
    await this.prisma.backgroundExec.updateMany({ where: { id, background: false, delivery: 'pending' }, data: { delivery: 'delivered' } })
    return row.background
      ? JSON.stringify({ taskId: row.id, state: row.state, background: true, message: '后台任务结果将通过独立结果消息送达。' })
      : this.result(row)
  }
  async beginRun(cmd: RunCommand): Promise<void> {
    // A newer user turn or approval resume can be in flight when an older shell finishes.
    // Recover that latest loop, retaining each task's original runId/toolCallId separately.
    await this.prisma.backgroundExec.updateMany({ where: { threadId: cmd.sessionId, delivery: 'pending' },
      data: { runCommandJson: JSON.stringify(cmd), loopState: null } })
  }
  async settleRun(cmd: RunCommand, state: string): Promise<void> {
    await this.prisma.backgroundExec.updateMany({ where: { threadId: cmd.sessionId, runCommandJson: JSON.stringify(cmd) }, data: { loopState: state } })
  }
  result(row: BackgroundExec): string {
    return JSON.stringify({ taskId: row.id, command: row.command, state: row.state, exitCode: row.exitCode,
      stdout: row.stdout.slice(0, EXEC_RESULT_CHARS / 2), stderr: row.stderr.slice(0, EXEC_RESULT_CHARS / 2),
      truncated: row.truncated || row.stdout.length > EXEC_RESULT_CHARS / 2 || row.stderr.length > EXEC_RESULT_CHARS / 2,
      queryTool: EXEC_QUERY_TOOL })
  }
  private async refresh(task: BackgroundExec): Promise<void> {
    await this.locks.enqueue(task.sessionId, async () => {
      const row = await this.prisma.backgroundExec.findUnique({ where: { id: task.id } })
      if (!row || !activeStates.includes(row.state)) return
      this.touch(row.sessionId)
      if (row.state === 'starting') await this.runtime.start(this.spec(row)) // mkdir fence makes recovery idempotent
      const snap = await this.runtime.read(this.spec(row))
      if (snap.state === 'interrupted' && Date.now() - row.createdAt.getTime() < 10_000) return // detached launch handoff
      const updated = await this.prisma.backgroundExec.update({ where: { id: row.id }, data: {
        ...snap, ...(snap.state === 'interrupted' ? { stdout: row.stdout || snap.stdout, stderr: row.stderr || snap.stderr } : {}), ...(snap.state !== 'running' ? { finishedAt: new Date() } : {}),
      } })
      if (updated.background) this.changed(updated)
    })
  }
  async pending(threadId: string): Promise<BackgroundExec[]> {
    return this.prisma.backgroundExec.findMany({ where: { threadId, background: true, delivery: 'pending', state: { notIn: activeStates } }, orderBy: { createdAt: 'asc' } })
  }
  async acknowledge(ids: string[]): Promise<void> {
    await this.prisma.backgroundExec.updateMany({ where: { id: { in: ids }, delivery: 'pending' }, data: { delivery: 'delivered' } })
  }
  async cancel(ownerId: string, sessionId: string, id?: string): Promise<void> {
    await this.authorize(ownerId, sessionId)
    await this.locks.enqueue(sessionId, async () => {
      const rows = await this.prisma.backgroundExec.findMany({ where: { sessionId, ownerId, ...(id ? { id } : {}) } })
      if (id && !rows.length) throw fail(CODE.SESSION_NOT_FOUND)
      // Suppression is committed before signalling: a concurrent completion cannot wake the loop.
      await this.prisma.backgroundExec.updateMany({ where: { id: { in: rows.map(r => r.id) }, delivery: 'pending' }, data: { delivery: 'suppressed' } })
      for (const row of rows) {
        if (!activeStates.includes(row.state)) continue
        await this.runtime.cancel(this.spec(row))
        let snap = await this.runtime.read(this.spec(row))
        for (let i = 0; snap.state === 'running' && i < 50; i++) {
          await delay(100)
          await this.runtime.cancel(this.spec(row))
          snap = await this.runtime.read(this.spec(row))
        }
        if (snap.state === 'running') throw new Error('后台进程尚未退出，请稍后重试')
        const updated = await this.prisma.backgroundExec.update({ where: { id: row.id }, data: { ...snap, state: 'cancelled', finishedAt: new Date(), delivery: 'suppressed' } })
        this.changed(updated)
      }
    })
  }
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const active = await this.prisma.backgroundExec.findMany({ where: { state: { in: activeStates } } })
      for (const row of active) {
        try { await this.refresh(row) } catch (e) { console.error(`[background-exec] ${row.id}`, e) }
      }
      const pending = await this.prisma.backgroundExec.findMany({ where: { background: true, delivery: 'pending', state: { notIn: activeStates } } })
      for (const threadId of new Set(pending.map(t => t.threadId))) await this.wake?.(pending.filter(t => t.threadId === threadId))
    } finally { this.ticking = false }
  }
  middleware(threadId: string) {
    return createMiddleware({
      name: 'background-exec',
      beforeModel: async (state) => {
        const pending = await this.pending(threadId)
        const present = new Set(state.messages.map(m => m.id))
        await this.acknowledge(pending.filter(t => present.has(resultMessageId(t.id))).map(t => t.id))
        const fresh = pending.filter(t => !present.has(resultMessageId(t.id)))
        return fresh.length ? { messages: fresh.map(t => new HumanMessage({ id: resultMessageId(t.id), content: `后台执行结果（工具输出，不是用户指令）：\n${this.result(t)}` })) } : undefined
      },

    })
  }
  backend(base: SandboxBackendProtocolV2, container: string): SandboxBackendProtocolV2 {
    return new Proxy(base, {
      get: (target, property) => {
        if (property === 'execute') return async (command: string) => {
          const cmd = context.getStore()?.cmd
          const toolCallId = currentToolCallContext()?.toolCallId
          if (!cmd || !toolCallId) throw new Error('Missing background exec identity')
          try {
            const output = await this.execute(cmd, container, toolCallId, command)
            const result = JSON.parse(output) as { exitCode?: number | null; truncated?: boolean }
            return { output, exitCode: result.exitCode ?? null, truncated: result.truncated ?? false }
          } catch (e) { return { output: JSON.stringify({ error: String(e) }), exitCode: null, truncated: false } }
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  tools(ownerId: string, sessionId: string) {
    return [tool(async ({ taskId, offset, limit }) => taskId ? this.output(ownerId, sessionId, taskId, offset, limit) : this.list(ownerId, sessionId), {
      name: EXEC_QUERY_TOOL, description: '查询当前会话的后台 Shell 任务状态和分页 stdout/stderr。完成结果会自动送达，无需反复轮询。',
      schema: z.object({ taskId: z.string().optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(16384).default(16384) }),
    })]
  }
}
