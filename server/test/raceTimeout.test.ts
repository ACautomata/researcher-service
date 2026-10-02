// S3 纯逻辑单测（raceTimeout）：有界等待双语义——超时 reject（调用方补偿面）/
// 超时 resolve undefined 放行（shutdown void 面）；settle 即 clearTimeout。
import { describe, it, expect, vi } from 'vitest'
import { raceWithTimeout } from '../src/raceTimeout'

describe('raceWithTimeout', () => {
  it('预算内 settle → 原值透传，不触发超时路径', async () => {
    const result = await raceWithTimeout(Promise.resolve('ok'), 10_000, () => new Error('nope'))
    expect(result).toBe('ok')
  })

  it('超时且传 timeoutError → 以该错误 reject', async () => {
    await expect(
      raceWithTimeout(new Promise<never>(() => {}), 10, () => new Error('bounded')),
    ).rejects.toThrow('bounded')
  })

  it('超时且未传 timeoutError → resolve undefined 放行（void 语义面）', async () => {
    const result = await raceWithTimeout(new Promise<void>(() => {}), 10)
    expect(result).toBeUndefined()
  })

  it('settle 即 clearTimeout（fake timer 不再触发）', async () => {
    vi.useFakeTimers()
    try {
      const p = raceWithTimeout(Promise.resolve(1), 1_000, () => new Error('late'))
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(p).resolves.toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
