// #1088 评测逐样本 dispose 回归：子进程已退出时，dispose 不能等待不会再来的 exit 事件。
import { describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { LeasedProcessPool } from '../src/utils/leasedProcessPool'

function makePool(): LeasedProcessPool {
  return new LeasedProcessPool({
    corePath: resolve(__dirname, '../src/sessions/history/sqliteCore.cjs'),
    errors: {
      timeout: () => new Error('timeout'),
      abort: () => new Error('abort'),
      unavailable: () => new Error('unavailable'),
      code: (code: string) => new Error(code),
    },
  })
}

describe('LeasedProcessPool.dispose', () => {
  it('子进程已退出（exitCode 已落）时立即 resolve，不挂起等待错过的 exit 事件', async () => {
    const pool = makePool()
    const fakeChild = {
      exitCode: 0,
      signalCode: null,
      once: vi.fn(),
      kill: vi.fn(),
    } as unknown as ChildProcess
    ;(pool as unknown as { children: Set<ChildProcess> }).children.add(fakeChild)
    const result = await Promise.race([
      pool.dispose().then(() => 'done' as const),
      new Promise<'timeout'>(resolveTimeout => setTimeout(() => resolveTimeout('timeout'), 200)),
    ])
    expect(result).toBe('done')
    expect(fakeChild.once).not.toHaveBeenCalled()
  })

  it('仍在运行的子进程在 kill 后等到真实 exit 事件', async () => {
    const pool = makePool()
    let exitListener: (() => void) | undefined
    const fakeChild = {
      pid: process.pid,
      exitCode: null,
      signalCode: null,
      once: vi.fn((_event: string, listener: () => void) => { exitListener = listener }),
      off: vi.fn(),
      kill: vi.fn(() => { queueMicrotask(() => exitListener?.()) }),
    } as unknown as ChildProcess
    ;(pool as unknown as { children: Set<ChildProcess> }).children.add(fakeChild)
    ;(pool as unknown as { slots: Array<{ child?: ChildProcess }> }).slots.push({ child: fakeChild })
    const disposed = pool.dispose()
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL')
    await disposed
    expect(fakeChild.once).toHaveBeenCalledWith('exit', expect.any(Function))
  })
})
