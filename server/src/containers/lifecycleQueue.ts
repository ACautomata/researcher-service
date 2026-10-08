// 「按 name 串行」（k8s Terminating 式）——同 name 生命周期操作排队执行，从根上消除
// delete vs create/recreate 竞态（沙箱/wiki 容器两支路 lifecycle 共用，#776/#784）。
//
// #858 OpenClaw 退役③：旧 LifecycleQueue Port（后台执行 + worker 并发上限 + 崩溃重跑）与
// InlineLifecycleQueue/BullMqLifecycleQueue 随 fleet 生命周期队列退役删除——wiki/sandbox 两支路
// 的串行语义只依赖本串行器（per-name Promise 链，进程内、不依赖 Redis）。

// 按 name 串行器：同 name 的任务排队逐个执行；不同 name 互不阻塞。
// 进程内 Map<name, Promise> 链，崩溃即随进程消失（后台任务持久化/重跑无生产消费方——
// wiki/sandbox 生命周期操作都是请求内联完成的前台语义）。
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
