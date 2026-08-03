// wiki compile 触发（#335 · #315 §6 平移 backend/wiki/compile.py）。
//
// POST 新建 / DELETE 删除后触发、PUT 编辑不触发；按容器名去抖 5s 合并多次写为一次。
// 真实执行走容器内 exec `openclaw wiki compile`（docker exec 通道，不经 gateway WS），
// best-effort 吞错不阻断落盘。Node 单线程事件循环无需锁；timer `.unref()` 等价
// Python daemon=True（不阻止进程退出）。

export interface CompileTrigger {
  trigger(name: string): void
}

export type RuntimeExec = (name: string, cmd: string[]) => Promise<void>

// 真实触发：容器内 exec openclaw wiki compile（best-effort，失败不阻断写操作）。
export class DockerCompileExecutor {
  constructor(private readonly exec: RuntimeExec) {}

  async execute(name: string): Promise<void> {
    try {
      await this.exec(name, ['openclaw', 'wiki', 'compile'])
    } catch {
      // best-effort：compile 失败仅影响搜索索引/digest 同步，不阻断落盘（r29 §2.4）
    }
  }
}

// 按容器名去抖合并的 compile 触发器：窗口内多次写只触发一次（clearTimeout 重设 + .unref()）。
export class DebouncedCompileTrigger implements CompileTrigger {
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly executor: { execute(name: string): Promise<void> },
    private readonly debounceMs = 5000,
  ) {}

  trigger(name: string): void {
    const existing = this.timers.get(name)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      this.timers.delete(name)
      void this.executor.execute(name).catch(() => {})
    }, this.debounceMs)
    t.unref()
    this.timers.set(name, t)
  }
}

// 无编排/测试缺省：不触发。
export const noopCompile: CompileTrigger = { trigger: () => {} }

// 生产装配：从 ContainerRuntime 造 compile 触发器（docker exec openclaw wiki compile）。
export function makeDockerCompile(runtime: {
  execInContainer(name: string, cmd: string[]): Promise<void>
}): CompileTrigger {
  return new DebouncedCompileTrigger(new DockerCompileExecutor((name, cmd) => runtime.execInContainer(name, cmd)))
}
