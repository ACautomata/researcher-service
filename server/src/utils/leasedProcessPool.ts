// 只读查询执行进程池（#1079 历史 / #1082 反思共用原语）。
//
// 每次查询调用独占一条子进程（每用户 1、全平台 4，调用方各自配置）；子进程只读打开 SQLite。
// 协作时限由核心逐行检查；硬停止由主进程 SIGKILL 子进程——真实终止，不是 Promise.race 假停。
// 任何子进程错误都不把 stderr/堆栈/路径带回业务响应。

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface ProcessTaskPayload {
  readonly fn: string
  readonly [key: string]: unknown
}

export interface ProcessTaskOptions {
  readonly signal?: AbortSignal
  /** 协作时限（相对毫秒）；核心逐行检查。 */
  readonly cooperativeMs: number
  /** 硬停止（相对毫秒）：主进程到点 SIGKILL 子进程。 */
  readonly hardMs: number
}

export interface ProcessLease {
  run<T>(payload: ProcessTaskPayload, options: ProcessTaskOptions): Promise<T>
  release(): void
}

export interface LeasedProcessPoolOptions {
  /** 核心模块绝对路径（子进程用 createRequire 加载；同时作为 better-sqlite3 解析基准）。 */
  readonly corePath: string
  readonly maxGlobal?: number
  readonly maxPerUser?: number
  readonly errors: {
    readonly timeout: () => Error
    readonly abort: () => Error
    readonly unavailable: () => Error
    readonly code: (code: string, denied?: unknown) => Error
  }
}

interface Slot {
  child?: ChildProcess
  ownerId?: string
}

function childIsAlive(child: ChildProcess): boolean {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return false
  try {
    process.kill(child.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** 子进程可能在 dispose 前已退出，或 exit 事件已在 SIGKILL 后错过；close 双监听 +
 *  存活探测 + 短兜底避免 unref 进程池永久挂起（Node 事件循环空后静默退出 0）。 */
function waitForChildExit(child: ChildProcess): Promise<void> {
  if (!childIsAlive(child)) return Promise.resolve()
  return new Promise<void>(resolveDone => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('exit', finish)
      child.off('close', finish)
      resolveDone()
    }
    const timer = setTimeout(finish, 2_000)
    child.once('exit', finish)
    child.once('close', finish)
    try { child.kill('SIGKILL') } catch { /* 已退出 */ }
  })
}

function resolveChildScript(): string | undefined {
  const candidates: string[] = []
  try {
    if (typeof __dirname === 'string' && __dirname) candidates.push(path.join(__dirname, 'readonlyProcessChild.cjs'))
  } catch {
    // ESM 运行时无 __dirname
  }
  candidates.push(path.join(process.cwd(), 'src/utils/readonlyProcessChild.cjs'))
  candidates.push(path.join(process.cwd(), 'dist/server/src/utils/readonlyProcessChild.cjs'))
  return candidates.find(candidate => existsSync(candidate))
}

export class LeasedProcessPool {
  private readonly maxGlobal: number
  private readonly maxPerUser: number
  private readonly slots: Slot[] = []
  private readonly leasesPerUser = new Map<string, number>()
  private readonly children = new Set<ChildProcess>()
  private closing?: Promise<void>
  private seq = 0
  private disposed = false

  constructor(private readonly options: LeasedProcessPoolOptions) {
    this.maxGlobal = options.maxGlobal ?? 4
    this.maxPerUser = options.maxPerUser ?? 1
  }

  lease(ownerId: string): ProcessLease | undefined {
    if (this.disposed) return undefined
    const slot = this.acquire(ownerId)
    if (!slot) return undefined
    let released = false
    return {
      run: <T>(payload: ProcessTaskPayload, options: ProcessTaskOptions) =>
        released ? Promise.reject(this.options.errors.unavailable()) : this.task<T>(slot, payload, options),
      release: () => {
        if (released) return
        released = true
        this.release(ownerId, slot)
      },
    }
  }

  /** 验证缝：子进程真实忙循环，用于证明协作超时、取消与 SIGKILL 硬停止。 */
  async probeBusy(ownerId: string, durationMs: number, options: ProcessTaskOptions): Promise<void> {
    const slot = this.takeProbeSlot(ownerId)
    if (!slot) throw this.options.errors.unavailable()
    try {
      await this.task(slot, { fn: 'probe-busy', durationMs }, options)
    } finally {
      this.probeDone(slot)
    }
  }

  async probeReadOnly(ownerId: string, dbPath: string, options: ProcessTaskOptions): Promise<boolean> {
    const slot = this.takeProbeSlot(ownerId)
    if (!slot) throw this.options.errors.unavailable()
    try {
      const data = await this.task<{ readonly: boolean }>(slot, { fn: 'probe-readonly', dbPath }, options)
      return data.readonly
    } finally {
      this.probeDone(slot)
    }
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing
    this.disposed = true
    const exits = [...this.children].map(waitForChildExit)
    for (const slot of this.slots) this.killSlot(slot)
    this.slots.length = 0
    this.leasesPerUser.clear()
    this.closing = Promise.all(exits).then(() => {})
    return this.closing
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

  private takeProbeSlot(ownerId: string): Slot | undefined {
    if (this.disposed) return undefined
    const perUser = this.leasesPerUser.get(ownerId) ?? 0
    if (perUser >= this.maxPerUser) return undefined
    let slot = this.slots.find(entry => entry.ownerId === undefined)
    if (!slot) {
      if (this.slots.length >= this.maxGlobal) return undefined
      slot = { ownerId: '__probe__' }
      this.slots.push(slot)
    }
    slot.ownerId = '__probe__'
    return slot
  }

  private probeDone(slot: Slot): void {
    if (slot.ownerId === '__probe__') slot.ownerId = undefined
  }

  private task<T>(slot: Slot, payload: ProcessTaskPayload, options: ProcessTaskOptions): Promise<T> {
    if (this.disposed) return Promise.reject(this.options.errors.unavailable())
    if (options.signal?.aborted) return Promise.reject(this.options.errors.abort())
    const child = this.ensureChild(slot)
    if (!child) return Promise.reject(this.options.errors.unavailable())
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
        if (slot.child === child) slot.child = undefined
        finish(() => reject(this.options.errors.unavailable()))
      }
      const onAbort = (): void => {
        this.killSlot(slot)
        finish(() => reject(this.options.errors.abort()))
      }
      const timer = setTimeout(() => {
        this.killSlot(slot)
        finish(() => reject(this.options.errors.timeout()))
      }, Math.max(1, options.hardMs))
      child.on('message', onMessage)
      child.once('exit', onExit)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        child.send({
          ...payload,
          id,
          // 子进程用自身真实时钟比较；协作时限由调用方保证通常早于硬停止——不在这里压到硬时限，
          // 否则「硬停止」会在子进程内变成协作返回，SIGKILL 终止路径无法被验证。
          cooperativeDeadline: Date.now() + options.cooperativeMs,
        }, error => {
          if (error) finish(() => reject(this.options.errors.unavailable()))
        })
      } catch {
        finish(() => reject(this.options.errors.unavailable()))
      }
    })
  }

  private childError(message: { code?: unknown; denied?: unknown }): Error {
    const code = typeof message.code === 'string' ? message.code : 'system_error'
    return this.options.errors.code(code, message.denied)
  }

  private ensureChild(slot: Slot): ChildProcess | undefined {
    if (slot.child && slot.child.exitCode === null && slot.child.signalCode === null) return slot.child
    try {
      const script = resolveChildScript()
      if (!script) return undefined
      const child = spawn(process.execPath, [script], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, RES_READONLY_MODULE_BASE: this.options.corePath, RES_READONLY_CORE: this.options.corePath },
      })
      child.unref()
      this.children.add(child)
      child.on('exit', () => {
        this.children.delete(child)
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
