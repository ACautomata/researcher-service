// 进程内 name 互斥租约（#313 并发模型核心）。
// 弃 Redis 分布式锁：Node 单进程单事件循环，进程内 Map 天然跨请求可见，且**锁不依赖 Redis**——
// 即使 Redis 挂也防双创建/双删除。await 挂起期间其它请求会进来，故显式互斥仍必须。
// tryAcquire 非阻塞：已被持有返 null（快速失败语义，对齐旧 inflight guard / Redis try_acquire）。

export interface Lease {
  release(): void
}

export class NameLeaseMap {
  private readonly held = new Set<string>()

  // 非阻塞取租约：name 已被持有 → null；否则登记并返回句柄（release 幂等）。
  tryAcquire(name: string): Lease | null {
    if (this.held.has(name)) return null
    this.held.add(name)
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.held.delete(name)
      },
    }
  }

  // 探测 name 是否被持有（delete/reconcile 判「是否有在飞 create」）。
  isHeld(name: string): boolean {
    return this.held.has(name)
  }
}
