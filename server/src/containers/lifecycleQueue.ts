// 生命周期后台队列（#313 并发模型：进程内互斥 + BullMQ(Redis) 队列 + SQLite 持状态）。
//
// 两层职责分离：
// - LifecycleQueue（Port）：后台执行 + **worker 并发上限**（默认 2）+ 崩溃重跑。
//   生产实现 BullMqLifecycleQueue（Redis-backed、stalled-job 崩溃重跑补 provisioning 中断对账缺口）；
//   测试注入 InlineLifecycleQueue（同步 inline，接缝 #5）。
// - NameSerializer：「按 name 串行」（k8s Terminating 式）——同 name 生命周期操作排队执行，
//   从根上消除 delete vs create/recreate 竞态。per-name Promise 链，进程内、不依赖 Redis。
//
// 入队串行由 NameSerializer 提供（语义必需）；并发上限/崩溃重跑由 LifecycleQueue 提供（生产刚需）。

export type LifecycleTask = () => Promise<void>

export interface LifecycleQueue {
  // 提交一个后台任务（按 worker 并发调度）。返回的 Promise 在该任务完成时 settle。
  submit(task: LifecycleTask): Promise<void>
  // 启动 worker 消费（生产 BullMQ 用；inline 为 no-op）。
  start?(): void | Promise<void>
  // 优雅关闭（drain 在飞任务）。
  close(): Promise<void>
}

// 同步 inline 实现：测试接缝（后台 provisioning 同步跑完，便于断言终态）。并发上限不适用。
export class InlineLifecycleQueue implements LifecycleQueue {
  async submit(task: LifecycleTask): Promise<void> {
    await task()
  }
  async close(): Promise<void> {}
}

// 按 name 串行器：同 name 的任务排队逐个执行；不同 name 互不阻塞。
// 进程内 Map<name, Promise> 链，崩溃即随进程消失（任务持久化/重跑由 LifecycleQueue 的
// BullMQ stalled-job 兜底；本串行器只管「同一时刻同 name 不并发」）。
export class NameSerializer {
  private readonly chains = new Map<string, Promise<unknown>>()

  // 把 task 排到 name 的队尾：等该 name 前一个任务 settle（成功/失败都算）后执行。
  // 返回的 Promise 在本任务完成时 settle（resolve 其返回值 / reject 其错误，不阻断后续排队任务）。
  enqueue<T>(name: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(name) ?? Promise.resolve()
    const run = prev.catch(() => {}).then(task)
    // 链上存「不 reject」版本，保证一个任务的失败不会让整条链永久 reject。
    const stored = run.catch(() => {})
    this.chains.set(name, stored)
    // name 队列清空后释放 Map 项，避免长跑面板内存单调增长。
    // 挂到 reject-safe 的 stored 上（run 可能 reject——挂 run.finally 会再造 unhandled rejection）；
    // 且清理比较须用 stored（与 Map 中所存同引用），否则永不相等、条目泄漏。
    void stored.finally(() => {
      if (this.chains.get(name) === stored) this.chains.delete(name)
    })
    return run
  }
}
