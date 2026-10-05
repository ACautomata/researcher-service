// per-path 写锁注册表（#785 · #747 E 节「teammate 并发写互斥（#769 锁方案）」）。
//
// 方案钉死（#747 正文 230 行）：不硬隔离、锁为唯一机制——runner 进程内 per-path 写锁，
// 锁 key =（会话, normalizeFilePath 后 path）；覆盖 write/edit/delete 全部破坏性 fs op 与
// ingestion 物化/校验节点写；读不限（read/ls/glob/grep 接受瞬时不一致，V1 无快照/版本号）；
// 等待有界，超时向 agent 报错（报 path 与持有者），agent 自行决策重试/换路径；持锁者死亡
// 随 task 取消自动释放；锁不覆盖 shell 写（bash 工具为旁路，与 exec 显式降级同哲学延伸）。
//
// 无死锁面论证：工具调用单 path 粒度（一次工具调用只锁一个 path，无多 path 原子获取），
// 循环等待结构性不可能；rename 不在 V1 工具面，天然排除。锁表 per-session、in-process、
// 无持久状态（进程内 Map 即正确的分布式边界——concurrency.ts 同纪律；fork 与 rewind 零交互，
// 重放期间全会话写围栏由 C1 覆盖，锁只管稳态并发）。
//
// 排队语义：同 key FIFO 等待队列，release 移交队首；等待有界（默认 config.runner
// .writeLockTimeoutMs，env RUNNER_WRITE_LOCK_TIMEOUT_MS），超时拒等待者（错误携带 path 与
// 持有者标签）且不移动队首。lease.release 幂等（对齐 ConcurrencyGate.RunLease 纪律）。
// 持锁者/等待者死亡面：releaseRun(runId) 释放该 run 全部持锁并取消其排队等待（RunService
// 在 run 终态 finally 调用——abort/failed 路径的兜底，正常路径由调用方 try/finally 先行释放）。

// 持有者身份：label 进超时报错（agent 可读），runId 是 task 取消清理键（可缺——非 run
// 语境的调用面如下载节点物化闭包只给 thread 标签，清理靠 try/finally 纪律兜底）。
export interface WriteLockHolder {
  readonly runId?: string
  readonly label: string
}

export interface WriteLockLease {
  release(): void
}

// 等待超时（有界等待的出口）：message 面向 agent（报 path 与持有者），字段供包装层结构化消费。
export class WriteLockTimeoutError extends Error {
  constructor(readonly params: { session: string; path: string; holderLabel: string; waitMs: number }) {
    super(
      `path ${params.path} is locked by ${params.holderLabel}; waited ${params.waitMs}ms — ` +
        'retry after the holder finishes, or write to a different path',
    )
    this.name = 'WriteLockTimeoutError'
  }
}

// 等待被取消（releaseRun 的等待者清理面——task 取消不再需要这把锁）。
export class WriteLockCancelledError extends Error {
  constructor(readonly params: { session: string; path: string }) {
    super(`write lock wait cancelled (run ended): path ${params.path}`)
    this.name = 'WriteLockCancelledError'
  }
}

export interface WriteLockRegistryOptions {
  /** 默认有界等待（毫秒；config.runner.writeLockTimeoutMs 注入；acquire 可按次覆盖） */
  readonly timeoutMs: number
}

// 有界等待默认值（单一来源：config.ts env 缺省回退 + RunService 测试缺省共用）。
export const DEFAULT_WRITE_LOCK_TIMEOUT_MS = 10_000

interface Waiter {
  session: string
  path: string
  holder: WriteLockHolder
  resolve: (lease: WriteLockLease) => void
  reject: (e: WriteLockTimeoutError | WriteLockCancelledError) => void
  timer: ReturnType<typeof setTimeout>
  settled: boolean
}

interface LockEntry {
  holder: WriteLockHolder
  waiters: Waiter[]
}

const keyOf = (session: string, path: string): string => `${session}\u0000${path}`

export class WriteLockRegistry {
  private readonly locks = new Map<string, LockEntry>()

  constructor(private readonly opts: WriteLockRegistryOptions) {
    if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs <= 0) {
      throw new Error(`writeLock timeoutMs 非法: ${opts.timeoutMs}（须为正整数——config 层已校验，此处防御）`)
    }
  }

  // 取锁：空闲即持有；被占则入 FIFO 队列有界等待。超时 → WriteLockTimeoutError（含 path
  // 与持有者标签）；run 取消（releaseRun）→ WriteLockCancelledError。
  async acquire(
    session: string,
    path: string,
    holder: WriteLockHolder,
    opts: { timeoutMs?: number } = {},
  ): Promise<WriteLockLease> {
    const key = keyOf(session, path)
    const entry = this.locks.get(key)
    if (!entry) {
      this.locks.set(key, { holder, waiters: [] })
      return this.leaseOf(key, holder)
    }
    const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs
    return new Promise<WriteLockLease>((resolve, reject) => {
      const waiter: Waiter = {
        session,
        path,
        holder,
        resolve,
        reject,
        settled: false,
        timer: setTimeout(() => {
          if (waiter.settled) return
          waiter.settled = true
          this.removeWaiter(key, waiter)
          reject(new WriteLockTimeoutError({ session, path, holderLabel: entry.holder.label, waitMs: timeoutMs }))
        }, timeoutMs),
      }
      waiter.timer.unref?.()
      entry.waiters.push(waiter)
    })
  }

  // 持锁者死亡清理（RunService run 终态 finally 调用）：释放该 run 全部持锁 + 取消其全部
  // 排队等待。幂等（无持锁/无等待 = no-op）。顺序铁律：先取消本 run 等待者再释放持锁——
  // 否则 release 的队首移交会把锁递给同 run 的死等待者（先到先得语义随 task 死亡失效）。
  releaseRun(runId: string): void {
    for (const [key, entry] of [...this.locks]) {
      for (const waiter of [...entry.waiters]) {
        if (waiter.holder.runId !== runId || waiter.settled) continue
        waiter.settled = true
        clearTimeout(waiter.timer)
        this.removeWaiter(key, waiter)
        waiter.reject(new WriteLockCancelledError({ session: waiter.session, path: waiter.path }))
      }
    }
    for (const [key, entry] of [...this.locks]) {
      if (entry.holder.runId === runId) this.releaseKey(key, entry)
    }
  }

  // 观测面（测试/健康检查；非产品 API）：当前持锁 key 集的 (session, path) 展开。
  held(): Array<{ session: string; path: string; holder: WriteLockHolder }> {
    return [...this.locks.entries()].map(([key, entry]) => {
      const [session, ...rest] = key.split('\u0000')
      return { session: session ?? '', path: rest.join('\u0000'), holder: entry.holder }
    })
  }

  private leaseOf(key: string, holder: WriteLockHolder): WriteLockLease {
    let released = false
    return {
      release: () => {
        if (released) {
          // over-release 可观测面（ConcurrencyGate 同纪律）：幂等不抛，告警留痕
          // eslint-disable-next-line no-console
          console.warn(`[runner] write-lock over-release: ${holder.label}（lease 重复释放已忽略）`)
          return
        }
        released = true
        const entry = this.locks.get(key)
        if (!entry) return
        this.releaseKey(key, entry)
      },
    }
  }

  // 释放 key：有等待者 → 移交队首（等待已结束，撤销其超时定时器）；否则删表项。
  private releaseKey(key: string, entry: LockEntry): void {
    const next = entry.waiters.shift()
    if (!next) {
      this.locks.delete(key)
      return
    }
    next.settled = true
    clearTimeout(next.timer)
    entry.holder = next.holder
    next.resolve(this.leaseOf(key, next.holder))
  }

  private removeWaiter(key: string, waiter: Waiter): void {
    const entry = this.locks.get(key)
    if (!entry) return
    const i = entry.waiters.indexOf(waiter)
    if (i >= 0) entry.waiters.splice(i, 1)
  }
}
