// #1079 · RF-T03 独立只读执行器。
//
// 每次历史工具调用独占一条子进程（每用户 1、全平台 4）；子进程只读打开 SQLite。
// 2 秒协作时限由业务层与核心逐行检查；5 秒硬停止由主进程 SIGKILL 子进程——真实终止，
// 不是 Promise.race 假停。任何子进程错误都不把 stderr/堆栈/路径带回业务响应。
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  HistoryCooperativeTimeout,
  HistoryExecutionTimeout,
  HistoryExecutionUnavailable,
  mapHistoryErrorCode,
  type HistoryContext,
  type HistoryExecutionLease,
  type HistoryReader,
  type HistoryScan,
  type HistoryScanOptions,
  type HistorySessionQuery,
} from './model'

export interface ProcessHistoryReaderOptions {
  readonly dbPath: string
  /** 全平台执行槽（默认 4）。 */
  readonly maxGlobal?: number
  /** 每用户执行槽（默认 1）。 */
  readonly maxPerUser?: number
  /** 单次工具调用协作时限（默认 2000ms）。 */
  readonly cooperativeMs?: number
  /** 单次工具调用硬停止（默认 5000ms）。 */
  readonly hardMs?: number
  readonly limits?: { sessions: number }
  readonly clock?: () => number
}

interface Slot {
  child?: ChildProcess
  ownerId?: string
}

interface TaskOptions {
  signal?: AbortSignal
  cooperativeDeadline: number
  hardDeadline: number
}

// 子进程脚本与 SQL 核心一样放在独立 .cjs 文件（不经 TS 构建、可被 execPath 直接执行）。
// 生产（CJS dist）用 __dirname；vitest 源目录用 cwd；二者都找不到时失败关闭。
function resolveScriptPath(file: string): string | undefined {
  const candidates: string[] = []
  try {
    if (typeof __dirname === 'string' && __dirname) candidates.push(path.join(__dirname, file))
  } catch {
    // ESM 运行时无 __dirname
  }
  candidates.push(path.join(process.cwd(), 'src/sessions/history', file))
  candidates.push(path.join(process.cwd(), 'dist/server/src/sessions/history', file))
  return candidates.find(candidate => existsSync(candidate))
}

export class ProcessHistoryReader implements HistoryReader {
  private readonly dbPath: string
  private readonly maxGlobal: number
  private readonly maxPerUser: number
  private readonly cooperativeMs: number
  private readonly hardMs: number
  private readonly limits: { sessions: number }
  private readonly clock: () => number
  private readonly slots: Slot[] = []
  private readonly leasesPerUser = new Map<string, number>()
  private seq = 0
  private disposed = false

  constructor(options: ProcessHistoryReaderOptions) {
    this.dbPath = options.dbPath
    this.maxGlobal = options.maxGlobal ?? 4
    this.maxPerUser = options.maxPerUser ?? 1
    this.cooperativeMs = options.cooperativeMs ?? 2_000
    this.hardMs = options.hardMs ?? 5_000
    this.limits = options.limits ?? { sessions: 1000 }
    this.clock = options.clock ?? Date.now
  }

  executionLease(context: HistoryContext, options: { signal?: AbortSignal; waitBudgetMs?: number } = {}): HistoryExecutionLease | undefined {
    if (this.disposed) return undefined
    const slot = this.acquire(context.ownerId)
    if (!slot) return undefined
    const started = this.clock()
    const cooperativeDeadline = started + this.cooperativeMs
    const remainingWait = options.waitBudgetMs ?? Number.POSITIVE_INFINITY
    const hardDeadline = started + Math.min(this.hardMs, Math.max(0, remainingWait))
    const signal = options.signal
    let released = false
    const reader: HistoryReader = {
      sessions: (ctx, scanOptions) => this.task<HistorySessionQuery>(slot, {
        type: 'sessions',
        dbPath: this.dbPath,
        context: ctx,
        options: scanOptions ?? {},
        limits: this.limits,
      }, { signal, cooperativeDeadline, hardDeadline }),
      scan: (ctx, sessionId, scanOptions) => this.task<HistoryScan>(slot, {
        type: 'scan',
        dbPath: this.dbPath,
        context: ctx,
        sessionId,
        options: scanOptions,
      }, { signal, cooperativeDeadline, hardDeadline }),
    }
    return {
      reader,
      release: () => {
        if (released) return
        released = true
        this.release(context.ownerId, slot)
      },
    }
  }

  // 直接调用（服务未使用租约时）：一次性占用槽并释放。
  sessions(context: HistoryContext, options: { sessionIds?: readonly string[] } = {}): Promise<HistorySessionQuery> {
    return this.withLease(context, lease => Promise.resolve(lease.reader.sessions(context, options)))
  }

  scan(context: HistoryContext, sessionId: string, options: HistoryScanOptions): Promise<HistoryScan> {
    return this.withLease(context, lease => Promise.resolve(lease.reader.scan(context, sessionId, options)))
  }

  /** 验证缝（B4/M6）：真实执行器中的只读连接拒绝写入。 */
  async probeReadOnly(): Promise<boolean> {
    const slot = this.takeProbeSlot()
    if (!slot) throw new HistoryExecutionUnavailable()
    try {
      const data = await this.task<{ readonly: boolean }>(slot, {
        type: 'probe-readonly',
        dbPath: this.dbPath,
      }, { cooperativeDeadline: this.clock() + this.cooperativeMs, hardDeadline: this.clock() + this.hardMs })
      return data.readonly
    } finally {
      this.probeDone(slot)
    }
  }

  /** 验证缝（B5/B6）：真实子进程忙循环，用于证明协作超时、取消与 SIGKILL 硬停止。 */
  async probeBusy(durationMs: number, options: { cooperativeMs?: number; hardMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    const slot = this.takeProbeSlot()
    if (!slot) throw new HistoryExecutionUnavailable()
    const started = this.clock()
    try {
      await this.task(slot, { type: 'probe-busy', durationMs }, {
        cooperativeDeadline: started + (options.cooperativeMs ?? this.cooperativeMs),
        hardDeadline: started + (options.hardMs ?? this.hardMs),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } finally {
      this.probeDone(slot)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const slot of this.slots) this.killSlot(slot)
    this.slots.length = 0
    this.leasesPerUser.clear()
  }

  private acquire(ownerId: string): Slot | undefined {
    const perUser = this.leasesPerUser.get(ownerId) ?? 0
    if (perUser >= this.maxPerUser) return undefined
    let slot = this.slots.find(entry => entry.ownerId === undefined && entry.child !== undefined)
      ?? this.slots.find(entry => entry.ownerId === undefined)
    if (!slot) {
      if (this.slots.length >= this.maxGlobal) return undefined
      slot = {}
      this.slots.push(slot)
    }
    slot.ownerId = ownerId
    this.leasesPerUser.set(ownerId, perUser + 1)
    return slot
  }

  private release(ownerId: string, slot: Slot): void {
    slot.ownerId = undefined
    const remaining = (this.leasesPerUser.get(ownerId) ?? 1) - 1
    if (remaining <= 0) this.leasesPerUser.delete(ownerId)
    else this.leasesPerUser.set(ownerId, remaining)
  }

  private takeProbeSlot(): Slot | undefined {
    const slot = this.slots.find(entry => entry.ownerId === undefined)
    if (slot) return slot
    if (this.slots.length >= this.maxGlobal) return undefined
    const created: Slot = { ownerId: '__probe__' }
    this.slots.push(created)
    return created
  }

  private probeDone(slot: Slot): void {
    if (slot.ownerId === '__probe__') slot.ownerId = undefined
  }

  private async withLease<T>(context: HistoryContext, run: (lease: HistoryExecutionLease) => Promise<T>): Promise<T> {
    const lease = this.executionLease(context)
    if (!lease) throw new HistoryExecutionUnavailable()
    try {
      return await run(lease)
    } finally {
      lease.release()
    }
  }

  private task<T>(slot: Slot, payload: Record<string, unknown>, options: TaskOptions): Promise<T> {
    if (this.disposed) return Promise.reject(new HistoryExecutionUnavailable())
    if (options.signal?.aborted) return Promise.reject(new HistoryCooperativeTimeout())
    const child = this.ensureChild(slot)
    if (!child) return Promise.reject(new HistoryExecutionUnavailable())
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.off('message', onMessage)
        child.off('exit', onExit)
        options.signal?.removeEventListener('abort', onAbort)
        fn()
      }
      const onMessage = (message: { id?: unknown; ok?: unknown; data?: unknown; code?: unknown; denied?: unknown }): void => {
        if (message?.id !== id) return
        if (message.ok) finish(() => resolve(message.data as T))
        else finish(() => reject(this.childError(message)))
      }
      const onExit = (): void => {
        slot.child = undefined
        finish(() => reject(new HistoryExecutionUnavailable()))
      }
      const onAbort = (): void => {
        this.killSlot(slot)
        finish(() => reject(new HistoryCooperativeTimeout()))
      }
      const timer = setTimeout(() => {
        this.killSlot(slot)
        finish(() => reject(new HistoryExecutionTimeout()))
      }, Math.max(1, options.hardDeadline - this.clock()))
      child.on('message', onMessage)
      child.once('exit', onExit)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        child.send({ ...payload, id, cooperativeDeadline: options.cooperativeDeadline }, error => {
          if (error) finish(() => reject(new HistoryExecutionUnavailable()))
        })
      } catch {
        finish(() => reject(new HistoryExecutionUnavailable()))
      }
    })
  }

  private childError(message: { code?: unknown; denied?: unknown }): Error {
    return mapHistoryErrorCode(message.code, message.denied) ?? new HistoryExecutionUnavailable()
  }

  private ensureChild(slot: Slot): ChildProcess | undefined {
    if (slot.child && slot.child.exitCode === null && slot.child.signalCode === null) return slot.child
    try {
      const core = resolveScriptPath('sqliteCore.cjs')
      const script = resolveScriptPath('executorChild.cjs')
      if (!core || !script) return undefined
      const child = spawn(process.execPath, [script], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, RES_HISTORY_MODULE_BASE: core, RES_HISTORY_CORE: core },
      })
      child.unref()
      child.on('exit', () => {
        if (slot.child === child) slot.child = undefined
      })
      slot.child = child
      return child
    } catch {
      return undefined
    }
  }

  private killSlot(slot: Slot): void {
    const child = slot.child
    slot.child = undefined
    if (!child) return
    try {
      child.kill('SIGKILL')
    } catch {
      // 已退出
    }
  }
}
