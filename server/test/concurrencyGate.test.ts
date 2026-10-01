// ConcurrencyGate 并发场景测试（#775 验收 ③「per-user/全局并发闸门 40043 有并发场景测试」）。
//
// 纯逻辑单测（接缝 S3）：并发 acquire 竞争（await 点交错）、per-user 满拒、全局满拒、
// release 后再取、runWithLease finally 释放（含 fn 抛错）、幂等 release、40043 码面。

import { describe, it, expect } from 'vitest'
import { ConcurrencyGate } from '../src/runner/concurrency'
import { EnvelopeError } from '../src/envelope'

const limits: Record<string, number> = { alice: 2, bob: 5 }

describe('ConcurrencyGate（#775 · 731 §5.3）', () => {
  it('per-user 满额：第 maxConcurrentRuns+1 个 acquire → 40043', async () => {
    const gate = new ConcurrencyGate({ globalLimit: 100, loadUserLimit: async (id) => limits[id] })
    const leases = [await gate.acquire('alice'), await gate.acquire('alice')]
    expect(gate.inFlight('alice')).toBe(2)
    await expect(gate.acquire('alice')).rejects.toMatchObject({ code: 40043 })
    leases.forEach((l) => l.release())
    expect(gate.inFlight('alice')).toBe(0)
  })

  it('per-user 配额独立：alice 满不影响 bob', async () => {
    const gate = new ConcurrencyGate({ globalLimit: 100, loadUserLimit: async (id) => limits[id] })
    await gate.acquire('alice')
    await gate.acquire('alice')
    await expect(gate.acquire('alice')).rejects.toMatchObject({ code: 40043 })
    await expect(gate.acquire('bob')).resolves.toBeTruthy()
  })

  it('全局满额：跨用户合计达 globalLimit 后任何 acquire → 40043', async () => {
    const gate = new ConcurrencyGate({ globalLimit: 3, loadUserLimit: async () => 10 })
    const a = await gate.acquire('u1')
    const b = await gate.acquire('u2')
    const c = await gate.acquire('u3')
    expect(gate.inFlight()).toBe(3)
    await expect(gate.acquire('u4')).rejects.toMatchObject({ code: 40043 })
    await expect(gate.acquire('u1')).rejects.toMatchObject({ code: 40043 }) // 全局优先于 per-user 判
    a.release()
    expect(gate.inFlight()).toBe(2)
    await expect(gate.acquire('u4')).resolves.toBeTruthy()
    b.release()
    c.release()
  })

  it('release 后额度回收：同 user 可再取', async () => {
    const gate = new ConcurrencyGate({ globalLimit: 10, loadUserLimit: async () => 1 })
    const l1 = await gate.acquire('solo')
    await expect(gate.acquire('solo')).rejects.toMatchObject({ code: 40043 })
    l1.release()
    await expect(gate.acquire('solo')).resolves.toBeTruthy()
  })

  it('lease.release 幂等（重复释放不产生负计数/多退）', async () => {
    const gate = new ConcurrencyGate({ globalLimit: 10, loadUserLimit: async () => 5 })
    const lease = await gate.acquire('u')
    lease.release()
    lease.release()
    lease.release()
    expect(gate.inFlight()).toBe(0)
    expect(gate.inFlight('u')).toBe(0)
  })

  it('并发 acquire 竞争（交错 await）：限额窗口内恰好放行 N 个', async () => {
    const gate = new ConcurrencyGate({ globalLimit: 100, loadUserLimit: async () => 2 })
    // 10 个并发 acquire 同一用户：额度读取经 await 交错，计数检查+自增原子
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => gate.acquire('racer')))
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(2)
    expect(rejected).toHaveLength(8)
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(EnvelopeError)
      expect((r as PromiseRejectedResult).reason.code).toBe(40043)
    }
  })

  it('全局闸竞态回归（Spec R2 实证）：异用户并发撞 globalLimit——检查在唯一 await 之后、与自增紧邻，恰好放行 globalLimit 个', async () => {
    // 修前：全局检查在 await loadUserLimit 之前，10 个并发 acquire 全部越过检查 → inFlight=10。
    // 修后：检查排在 await 之后、自增之前（无 interleaving 窗口）→ 恰 2 放行 8 拒。
    const gate = new ConcurrencyGate({ globalLimit: 2, loadUserLimit: async () => 10 })
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => gate.acquire(`gu-${i}`)),
    )
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(2)
    expect(rejected).toHaveLength(8)
    expect(gate.inFlight()).toBe(2)
    expect(
      rejected.every((r) => (r as PromiseRejectedResult).reason.code === 40043),
    ).toBe(true)
    fulfilled.forEach((r) => (r as PromiseFulfilledResult<{ release(): void }>).value.release())
    expect(gate.inFlight()).toBe(0)
  })

  it('runWithLease：fn 完成自动释放', async () => {
    const gate = new ConcurrencyGate({ globalLimit: 10, loadUserLimit: async () => 1 })
    const out = await gate.runWithLease('w', async () => {
      expect(gate.inFlight('w')).toBe(1)
      return 'done'
    })
    expect(out).toBe('done')
    expect(gate.inFlight('w')).toBe(0)
  })

  it('runWithLease：fn 抛错也在 finally 释放（防漏释放泄漏额度）', async () => {
    const gate = new ConcurrencyGate({ globalLimit: 10, loadUserLimit: async () => 1 })
    await expect(
      gate.runWithLease('w2', async () => {
        throw new Error('run failed')
      }),
    ).rejects.toThrow('run failed')
    expect(gate.inFlight('w2')).toBe(0)
    // 释放后额度可复用
    await expect(gate.runWithLease('w2', async () => 'ok2')).resolves.toBe('ok2')
  })

  it('额度即时读：admin 中途上调配额即刻生效（非构造期快照）', async () => {
    let limit = 1
    const gate = new ConcurrencyGate({ globalLimit: 10, loadUserLimit: async () => limit })
    const l1 = await gate.acquire('flex')
    await expect(gate.acquire('flex')).rejects.toMatchObject({ code: 40043 })
    limit = 2 // admin 上调
    await expect(gate.acquire('flex')).resolves.toBeTruthy()
    l1.release()
  })

  it('坏配额值（负/非整数）视作拒绝（保护面而非放行）', async () => {
    const gate = new ConcurrencyGate({ globalLimit: 10, loadUserLimit: async () => -1 })
    await expect(gate.acquire('bad')).rejects.toMatchObject({ code: 40043 })
  })

  it('globalLimit 非法（0/负/非整数）构造期抛错（防御）', () => {
    expect(() => new ConcurrencyGate({ globalLimit: 0, loadUserLimit: async () => 1 })).toThrow()
    expect(() => new ConcurrencyGate({ globalLimit: -3, loadUserLimit: async () => 1 })).toThrow()
    expect(() => new ConcurrencyGate({ globalLimit: 1.5, loadUserLimit: async () => 1 })).toThrow()
  })
})
