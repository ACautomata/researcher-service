// wiki compile 触发单测（#335 · #315 §6）：DebouncedCompileTrigger 去抖/合并 +
// DockerCompileExecutor 走 docker exec `openclaw wiki compile`（best-effort 吞错）。
// 对齐 backend/wiki/tests/test_compile_executor.py 的行为断言。

import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  DebouncedCompileTrigger,
  DockerCompileExecutor,
  makeDockerCompile,
  type CompileTrigger,
} from '../src/wiki/compile'

afterEach(() => {
  vi.useRealTimers()
})

describe('DebouncedCompileTrigger', () => {
  it('窗口内多次触发合并为一次（clearTimeout 重设 + 5s 去抖）', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const trigger = new DebouncedCompileTrigger({ execute: async (n) => { calls.push(n) } })
    trigger.trigger('a')
    trigger.trigger('a') // 窗口内重设 → 只触发一次
    trigger.trigger('a')
    await vi.advanceTimersByTimeAsync(4999)
    expect(calls).toEqual([]) // 未到窗口
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toEqual(['a'])
  })

  it('不同容器各自去抖，互不干扰', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const trigger = new DebouncedCompileTrigger({ execute: async (n) => { calls.push(n) } })
    trigger.trigger('a')
    trigger.trigger('b')
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls.sort()).toEqual(['a', 'b'])
  })

  it('窗口内重设：再次 trigger 把该容器的触发延后（合并为一次）', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const trigger = new DebouncedCompileTrigger({ execute: async (n) => { calls.push(n) } })
    trigger.trigger('a') // 计划 t=5000
    await vi.advanceTimersByTimeAsync(3000)
    trigger.trigger('a') // 重设 → t=8000
    await vi.advanceTimersByTimeAsync(2000) // t=5000：旧窗口本应触发，但已重设 → 无
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(3000) // t=8000：触发一次
    expect(calls).toEqual(['a'])
  })

  it('executor 失败不导致未处理 rejection（best-effort）', async () => {
    vi.useFakeTimers()
    const trigger = new DebouncedCompileTrigger({ execute: async () => { throw new Error('daemon down') } })
    trigger.trigger('a')
    // 不应抛 / 不应有 unhandled rejection
    await vi.advanceTimersByTimeAsync(5000)
  })
})

describe('DockerCompileExecutor', () => {
  it('经 runtime exec 触发 `openclaw wiki compile`（非 gateway WS）', async () => {
    const execCalls: Array<{ name: string; cmd: string[] }> = []
    const executor = new DockerCompileExecutor(async (name, cmd) => { execCalls.push({ name, cmd }) })
    await executor.execute('demo')
    expect(execCalls).toEqual([{ name: 'demo', cmd: ['openclaw', 'wiki', 'compile'] }])
  })

  it('exec 抛错 → 吞掉不上抛（best-effort 不阻断写操作）', async () => {
    const executor = new DockerCompileExecutor(async () => { throw new Error('daemon down') })
    await expect(executor.execute('demo')).resolves.toBeUndefined()
  })
})

describe('makeDockerCompile', () => {
  it('从 runtime 装配去抖触发器；触发走 runtime.execInContainer', async () => {
    vi.useFakeTimers()
    const execCalls: string[] = []
    const runtime = {
      execInContainer: async (name: string, _cmd: string[]): Promise<void> => { execCalls.push(name) },
    }
    const trigger: CompileTrigger = makeDockerCompile(runtime)
    trigger.trigger('c1')
    trigger.trigger('c1')
    await vi.advanceTimersByTimeAsync(5000)
    expect(execCalls).toEqual(['c1'])
  })
})
