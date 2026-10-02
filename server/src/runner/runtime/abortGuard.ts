// abort 泄漏守门（#777）：LangGraph PregelRunner._executeTasksWithRetry 的 abortPromise
// 泄漏（上游 1.4.18 实测）——signal abort 后若 tick 循环由任务完成路径退出，已 reject 的
// abortPromise 不再被 race 消费 → unhandledRejection。Node ≥15 默认 unhandled rejection =
// 进程 crash：用户中止一个 run 会打挂整个控制面（集中式 runner 单点），必须本地缓解。
//
// 语义：已知 abort 形态（AbortError 名 / 上游裸 Error('Abort')，判据见 isAbortReason）→
// 留痕即消化（run 侧终态 run.aborted 已由 RunService 发出，此处只是接住上游泄漏面）；其余
// reason **throw-through**（转 uncaughtException，保持
// 「未知 unhandled 仍然 crash」的默认失败语义不变——守门只窄化到已知上游缺陷）。
// 三包升级时复测：上游修复（abortPromise 消费）后本守门可整段删除。

let installed = false

// 已知 abort 泄漏面的类型判据（不按文案猜——errorKind 同纪律；模糊 /abort/i 匹配会吞应用
// 自身 fetch abort 泄漏等真实 bug，弃用）：
//   name === 'AbortError' —— AbortController 缺省 reason 的标准名（DOMException/Error 同名；
//                            lib 无 dom，鸭子判定覆盖两形态）
//   Error('Abort')        —— 上游 PregelRunner abortPromise 的裸文案形态（实测）
function isAbortReason(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) return false
  if ((reason as { name?: unknown }).name === 'AbortError') return true
  return reason instanceof Error && reason.message === 'Abort'
}

export function installAbortRejectionGuard(log: (msg: string) => void = (m) => console.warn(m)): void {
  if (installed) return
  installed = true
  process.on('unhandledRejection', (reason) => {
    if (isAbortReason(reason)) {
      log(`[runner] 吞掉 LangGraph abort 泄漏 rejection（run.aborted 终态已另行发出）: ${
        reason instanceof Error ? reason.message : String(reason)
      }`)
      return
    }
    // 未知 unhandled 语义不变：throw-through → uncaughtException → crash
    throw reason
  })
}
