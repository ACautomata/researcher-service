// T03 测试 Port 假体（test 目录，非生产代码）。
//
// 三件事：
//   1. 记录每次 generate 的 input 与 credential——**分开**记录（T03 边界纪律：凭证是服务端执行
//      上下文，不与生成输入混同；验收「凭证被注入 Port 且不与 prompt 混同」的断言点）。
//   2. 可编排结果：脚本队列（每次弹一个；空则默认成功）、抛错模式（模拟执行体崩溃）、
//      挂起模式（generate 返回受控 pending，测试 resolveNext() 驱动——驱动 concurrency=1
//      下的重叠执行场景）。
//   3. 计数 generate 调用，配合 active 守卫断言「不重复执行 / 不自动重试」。

import type {
  AutoFigureGenerationCredential,
  AutoFigureGenerationInput,
  AutoFigureGenerationPort,
  AutoFigureGenerationResult,
} from '../src/figures/port'

export class FakeAutoFigureGenerationPort implements AutoFigureGenerationPort {
  /** 每次 generate 的 (input, credential) 记录——分别断言，不混同 */
  calls: Array<{ input: AutoFigureGenerationInput; credential: AutoFigureGenerationCredential }> = []
  /** 抛错模式：generate 抛异常（模拟执行体崩溃/网络异常 → runner 归一 failed） */
  throwOnGenerate = false
  /** 挂起模式：generate 返回受控 pending promise，由 resolveNext() 手动 settle */
  mode: 'auto' | 'pending' = 'auto'

  private readonly script: AutoFigureGenerationResult[]
  private readonly resolvers: Array<(result: AutoFigureGenerationResult) => void> = []
  private readonly enteredWaiters: Array<() => void> = []

  constructor(script: AutoFigureGenerationResult[] = []) {
    this.script = [...script]
  }

  async generate(
    input: AutoFigureGenerationInput,
    credential: AutoFigureGenerationCredential,
  ): Promise<AutoFigureGenerationResult> {
    this.calls.push({ input, credential })
    // 同步块内先发「已进入」信号，再注册 pending resolver——测试先 await generateEntered()
    // 再 resolveNext()，即保证 resolver 已就位，消除竞态。
    this.enteredWaiters.shift()?.()
    if (this.throwOnGenerate) throw new Error('simulated port crash')
    if (this.mode === 'pending') {
      return new Promise((resolve) => {
        this.resolvers.push(resolve)
      })
    }
    return this.script.length > 0 ? (this.script.shift() as AutoFigureGenerationResult) : { ok: true }
  }

  /** 注册一个「下一次 generate 已进入」的等待点（必须在触发 generate 之前调用） */
  generateEntered(): Promise<void> {
    return new Promise((resolve) => {
      this.enteredWaiters.push(resolve)
    })
  }

  /** pending 模式下 resolve 下一次挂起的 generate（缺省成功结果） */
  resolveNext(result: AutoFigureGenerationResult = { ok: true }): void {
    this.resolvers.shift()?.(result)
  }
}
