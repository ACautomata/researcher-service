// run 并发闸门单测（#775 · 731 §5.3 · S3）。
// 覆盖验收「per-user/全局并发闸门 40043 有并发场景测试」：per-user 配额边界、全局上限跨 user
// 生效、release 释放后可再 acquire、over-release 防御、交错 acquire/release 下计数不变量
//（per-user 恒 ≤ userMax；全局恒 ≤ globalMax）。

import { describe, it, expect } from 'vitest'
import { CODE } from '../src/codes'
import { RunConcurrencyGate } from '../src/runner/runQuota'

describe('RunConcurrencyGate（per-user 信号量 + 全局在飞上限）', () => {
  it('per-user：达到 userMax 前 OK，超额同步抛 40043', () => {
    const gate = new RunConcurrencyGate(100)
    gate.acquire('u1', 2)
    gate.acquire('u1', 2)
    expect(() => gate.acquire('u1', 2)).toThrowError()
    try {
      gate.acquire('u1', 2)
      expect.unreachable('must throw')
    } catch (e) {
      expect((e as { code?: number }).code).toBe(CODE.CONCURRENCY_QUOTA_EXCEEDED)
    }
    expect(gate.inFlightFor('u1')).toBe(2)
  })

  it('release 释放槽位后可再 acquire；计数下限 0', () => {
    const gate = new RunConcurrencyGate(100)
    gate.acquire('u1', 1)
    expect(() => gate.acquire('u1', 1)).toThrowError()
    gate.release('u1')
    expect(() => gate.acquire('u1', 1)).not.toThrowError()
    expect(gate.inFlightFor('u1')).toBe(1)
    gate.release('u1')
    gate.release('u1') // over-release：防御不抛、不下穿 0
    expect(gate.inFlightFor('u1')).toBe(0)
    expect(gate.globalInFlightCount()).toBe(0)
  })

  it('全局上限跨 user 生效（per-user 各自未满也算满）', () => {
    const gate = new RunConcurrencyGate(3) // 全局 3
    gate.acquire('u1', 5)
    gate.acquire('u1', 5)
    gate.acquire('u2', 5)
    expect(gate.globalInFlightCount()).toBe(3)
    try {
      gate.acquire('u3', 5)
      expect.unreachable('must throw')
    } catch (e) {
      expect((e as { code?: number }).code).toBe(CODE.CONCURRENCY_QUOTA_EXCEEDED)
      expect((e as Error).message).toMatch(/系统并发已达上限/)
    }
    gate.release('u1')
    expect(() => gate.acquire('u3', 5)).not.toThrowError() // 全局空位释放后放行
  })

  it('per-user 满与全局满的消息区分（前端提示归因）；全局满时先于 per-user 判定', () => {
    const gate = new RunConcurrencyGate(5)
    gate.acquire('u1', 1)
    gate.acquire('u2', 1)
    // 全局有空位但 per-user 满 → per-user 配额消息
    try {
      gate.acquire('u1', 1)
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).toMatch(/配额上限/)
    }
    // 填满全局（各 user userMax=1，u3–u5 各占一席）→ 全局满消息
    gate.acquire('u3', 1)
    gate.acquire('u4', 1)
    gate.acquire('u5', 1)
    try {
      gate.acquire('u6', 1)
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).toMatch(/系统并发已达上限/)
    }
    // 全局满对 per-user 满的 u1 同样先行（全局检查在前，全局消息遮蔽 per-user 消息）
    try {
      gate.acquire('u1', 1)
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).toMatch(/系统并发已达上限/)
    }
  })

  it('userMax=0 / globalMax=0：一票即拒（admin 可显式停跑）', () => {
    const gate = new RunConcurrencyGate(0)
    expect(() => gate.acquire('u1', 2)).toThrowError()
    const gate2 = new RunConcurrencyGate(10)
    expect(() => gate2.acquire('u1', 0)).toThrowError()
  })

  it('并发场景：交错 acquire/release 不变量（per-user ≤ userMax、全局 ≤ globalMax）', async () => {
    const gate = new RunConcurrencyGate(5)
    const users = ['u1', 'u2', 'u3']
    const userMax = 2
    let accepted = 0
    let rejected = 0

    const worker = async (userId: string) => {
      for (let i = 0; i < 20; i++) {
        try {
          gate.acquire(userId, userMax)
          accepted += 1
          // 模拟在飞 run：微任务后释放（acquire 同步，release 异步交错）
          await new Promise<void>((r) => setTimeout(r, 1))
          gate.release(userId)
        } catch {
          rejected += 1
          await new Promise<void>((r) => setTimeout(r, 1))
        }
        // 不变量：任意时刻 per-user 与全局计数都不越界
        expect(gate.inFlightFor(userId)).toBeLessThanOrEqual(userMax)
        expect(gate.globalInFlightCount()).toBeLessThanOrEqual(5)
      }
    }
    // 10 worker 分摊 3 个 user：同 user 并发 worker（~4）> userMax=2、并发 worker 总数（10）
    // > global 5——per-user 与全局两道闸门都有真实竞争面。
    const workers: Array<Promise<void>> = []
    for (let w = 0; w < 10; w++) workers.push(worker(users[w % users.length]))
    await Promise.all(workers)
    // 无泄漏：全部释放后计数归零
    expect(gate.globalInFlightCount()).toBe(0)
    for (const u of users) expect(gate.inFlightFor(u)).toBe(0)
    expect(accepted).toBeGreaterThan(0)
    expect(rejected).toBeGreaterThan(0) // 确有被闸门拒过的请求
  })
})
