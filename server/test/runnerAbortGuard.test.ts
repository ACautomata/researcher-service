import { describe, it, expect, vi } from 'vitest'
import { installAbortRejectionGuard } from '../src/runner/runtime/abortGuard'

// S3（#777）：abort 泄漏守门——AbortError 消化留痕，未知 rejection throw-through
//（crash 语义不变）。幂等面：重复 install 只挂一次 handler。

describe('installAbortRejectionGuard', () => {
  it('AbortError → 消化留痕不抛', () => {
    const log = vi.fn()
    installAbortRejectionGuard(log)
    const err = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    expect(() => {
      // 直接模拟 handler 分发：process.emit 触发已注册 listener
      process.emit('unhandledRejection', err, Promise.resolve())
    }).not.toThrow()
    expect(log).toHaveBeenCalled()
  })

  it('abort 文案变体（上游 Error("Abort")）→ 消化', () => {
    installAbortRejectionGuard(() => {})
    expect(() => {
      process.emit('unhandledRejection', new Error('Abort'), Promise.resolve())
    }).not.toThrow()
  })

  it('DOMException AbortError（AbortController 缺省 reason 形态，非 Error 子类）→ 消化', () => {
    installAbortRejectionGuard(() => {})
    const ex = new (globalThis as unknown as { DOMException: new (m: string, n: string) => object }).DOMException(
      'This operation was aborted',
      'AbortError',
    )
    expect(() => {
      process.emit('unhandledRejection', ex, Promise.resolve())
    }).not.toThrow()
  })

  it('message 模糊含 abort（非判据）→ throw-through（匹配面收窄：不吞应用自身 abort 泄漏）', () => {
    installAbortRejectionGuard(() => {})
    expect(() => {
      process.emit('unhandledRejection', new Error('request aborted by client middleware'), Promise.resolve())
    }).toThrow('request aborted')
  })

  it('未知 rejection → throw-through（保持 crash 语义）', () => {
    installAbortRejectionGuard(() => {})
    expect(() => {
      process.emit('unhandledRejection', new Error('real bug'), Promise.resolve())
    }).toThrow('real bug')
  })

  it('非 Error reason（字符串）→ throw-through', () => {
    installAbortRejectionGuard(() => {})
    expect(() => {
      process.emit('unhandledRejection', 'raw string', Promise.resolve())
    }).toThrow('raw string')
  })
})
