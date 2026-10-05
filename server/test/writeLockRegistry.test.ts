// S3 纯逻辑单测（#785 · #747 E 节锁方案）：per-path 写锁注册表——互斥/FIFO/有界等待超时
// （报 path 与持有者）/lease 幂等/releaseRun 取消清理/并发压力（首验场景记录，teammate 上线复验）。

import { describe, it, expect, vi } from 'vitest'
import {
  WriteLockCancelledError,
  WriteLockRegistry,
  WriteLockTimeoutError,
} from '../src/runner/writelock/registry'

describe('WriteLockRegistry（#785 锁表）', () => {
  it('空闲即持有：acquire 立即得 lease，held 观测面可见 (session, path, holder)', async () => {
    const registry = new WriteLockRegistry({ timeoutMs: 1000 })
    const lease = await registry.acquire('sess-1', 'lab/a.txt', { label: 'run r1 (thread sess-1)', runId: 'r1' })
    expect(registry.held()).toEqual([
      {
        session: 'sess-1',
        path: 'lab/a.txt',
        holder: { label: 'run r1 (thread sess-1)', runId: 'r1' },
      },
    ])
    lease.release()
    expect(registry.held()).toEqual([])
  })

  it('per-path 互斥：同 path 第二个 acquire 等待首个 release 后才获得（串行化）', async () => {
    const registry = new WriteLockRegistry({ timeoutMs: 5000 })
    const first = await registry.acquire('sess-1', 'lab/a.txt', { label: 'h1', runId: 'r1' })
    let secondAcquired = false
    const second = registry.acquire('sess-1', 'lab/a.txt', { label: 'h2', runId: 'r2' }).then((l) => {
      secondAcquired = true
      return l
    })
    await Promise.resolve()
    expect(secondAcquired).toBe(false) // 未释放前等待者不得进入
    first.release()
    const s = await second
    expect(secondAcquired).toBe(true)
    expect(registry.held()[0]?.holder.label).toBe('h2')
    s.release()
  })

  it('不同 path / 不同会话互不阻塞', async () => {
    const registry = new WriteLockRegistry({ timeoutMs: 1000 })
    const a = await registry.acquire('sess-1', 'lab/a.txt', { label: 'h-a' })
    const b = await registry.acquire('sess-1', 'lab/b.txt', { label: 'h-b' })
    const c = await registry.acquire('sess-2', 'lab/a.txt', { label: 'h-c' })
    expect(registry.held()).toHaveLength(3)
    a.release()
    b.release()
    c.release()
  })

  it('FIFO：等待队列按序移交', async () => {
    const registry = new WriteLockRegistry({ timeoutMs: 5000 })
    const first = await registry.acquire('s', 'p', { label: 'h0' })
    const granted: string[] = []
    const w1 = registry.acquire('s', 'p', { label: 'w1' }).then((l) => (granted.push('w1'), l))
    const w2 = registry.acquire('s', 'p', { label: 'w2' }).then((l) => (granted.push('w2'), l))
    await Promise.resolve()
    first.release()
    const l1 = await w1
    expect(granted).toEqual(['w1'])
    l1.release()
    const l2 = await w2
    expect(granted).toEqual(['w1', 'w2'])
    l2.release()
  })

  it('有界等待超时：拒绝错误携带 path 与持有者标签；队首不受超时者影响', async () => {
    const registry = new WriteLockRegistry({ timeoutMs: 5000 })
    const first = await registry.acquire('s', 'lab/x.txt', { label: 'holder-run-9' })
    const timedOut = registry.acquire('s', 'lab/x.txt', { label: 'w-timeout' }, { timeoutMs: 20 })
    await expect(timedOut).rejects.toMatchObject({
      name: 'WriteLockTimeoutError',
      params: { path: 'lab/x.txt', holderLabel: 'holder-run-9', waitMs: 20 },
    })
    // 超时错误文案面向 agent：报 path 与持有者（#769 锁方案验收面）
    await timedOut.catch((e: WriteLockTimeoutError) => {
      expect(e.message).toContain('lab/x.txt')
      expect(e.message).toContain('holder-run-9')
      expect(e).toBeInstanceOf(WriteLockTimeoutError)
    })
    // 超时者已出队：release 后队首仍是后续正常等待者
    const next = registry.acquire('s', 'lab/x.txt', { label: 'w-next' })
    first.release()
    const l = await next
    expect(registry.held()[0]?.holder.label).toBe('w-next')
    l.release()
  })

  it('release 幂等：重复释放不抛（告警留痕），锁状态正确', async () => {
    const registry = new WriteLockRegistry({ timeoutMs: 1000 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lease = await registry.acquire('s', 'p', { label: 'h' })
    lease.release()
    lease.release()
    expect(registry.held()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('releaseRun：持锁者死亡 → 锁释放且移交队首；该 run 的等待者被取消', async () => {
    const registry = new WriteLockRegistry({ timeoutMs: 5000 })
    const held = await registry.acquire('s', 'p', { label: 'run-a', runId: 'run-a' })
    const cancelled = registry.acquire('s', 'p', { label: 'run-a-wait', runId: 'run-a' })
    const survivor = registry.acquire('s', 'p', { label: 'run-b', runId: 'run-b' })
    await Promise.resolve()
    registry.releaseRun('run-a')
    // 持锁释放 → 队首（run-b）获得；同 run 的等待者收到取消错误
    await expect(cancelled).rejects.toBeInstanceOf(WriteLockCancelledError)
    const l = await survivor
    expect(registry.held()[0]?.holder.label).toBe('run-b')
    void held
    l.release()
    expect(registry.held()).toEqual([])
  })

  it('releaseRun 幂等：无持锁/无等待时 no-op', () => {
    const registry = new WriteLockRegistry({ timeoutMs: 1000 })
    expect(() => registry.releaseRun('nope')).not.toThrow()
  })

  // 并发压力首验场景（#785 验收「有记录」；teammate 上线后同场景复验）：20 并发争同 path，
  // 全程 max in-flight = 1（严格串行）且全部最终获得（无饿死、无泄漏）。
  it('并发压力：20 并发争同 path 全部串行完成', async () => {
    const registry = new WriteLockRegistry({ timeoutMs: 10_000 })
    let inFlight = 0
    let maxInFlight = 0
    const done: number[] = []
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (async () => {
          const lease = await registry.acquire('sess-stress', 'lab/hot.txt', { label: `w${i}` })
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          done.push(i)
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4)))
          inFlight -= 1
          lease.release()
        })(),
      ),
    )
    expect(maxInFlight).toBe(1)
    expect(done).toHaveLength(20)
    expect(registry.held()).toEqual([])
  })

  it('构造防御：非法 timeoutMs fail-fast', () => {
    expect(() => new WriteLockRegistry({ timeoutMs: 0 })).toThrow()
    expect(() => new WriteLockRegistry({ timeoutMs: -1 })).toThrow()
    expect(() => new WriteLockRegistry({ timeoutMs: 1.5 })).toThrow()
  })
})
