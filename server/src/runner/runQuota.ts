// run 并发闸门（731 §5.3 / #775 story 55）：per-user 在飞 run 配额 + 全局在飞上限。
//
// 机制选型（731 §5.3 原文）：BullMQ 原生 limiter 的 per-user 组限流（groupKey）自 OSS 3.0 起是
// Pro 专属功能不可用；OSS 只有 queue 级 {max, duration}（启动速率语义，非「在飞并发」语义）。
// runner 与控制面同为单进程（#734 Notes），进程内原语就是正确的分布式边界——per-user 计数器
// （Map<ownerId, n>）+ 全局计数，acquire 在单线程事件循环内同步 check+increment（无 await 间隙，
// 天然原子）。多副本演进路径：换 Redis Lua 原子 INCR/DECR，接口不变（731 §5.3 升级路径）。
//
// 配额语义：per-user 上限 = users.maxConcurrentRuns（调用方读行传入）；全局上限 = env
// RUNNER_MAX_CONCURRENT_RUNS（config.runner.maxConcurrentRuns）。超额 → 40043（run 拒绝启动）；
// run 终态（含失败/abort）finally 释放。teammate 按会话计不额外占额度、figure 随会话 run 占额度
// ——release 粒度归调用方（run 域，#777），本闸门只管计数。
//
// 速率/token 限流首期不做（731 §5.3：usage 全量采数，出现滥用再加）。

import { CODE } from '../codes'
import { fail } from '../envelope'

export class RunConcurrencyGate {
  private readonly perUser = new Map<string, number>()
  private globalInFlight = 0

  constructor(private readonly globalMaxRuns: number) {}

  // 占一个在飞槽位；超额同步抛 40043（EnvelopeError——run 经 REST 启动时直接进信封错误面）。
  // 同步实现：check + increment 之间无 await，单线程事件循环下无并发交错。
  acquire(ownerId: string, userMaxRuns: number): void {
    if (this.globalInFlight >= this.globalMaxRuns) {
      throw fail(CODE.CONCURRENCY_QUOTA_EXCEEDED, '系统并发已达上限，请稍后重试')
    }
    const current = this.perUser.get(ownerId) ?? 0
    if (current >= userMaxRuns) {
      throw fail(CODE.CONCURRENCY_QUOTA_EXCEEDED, '并发 run 数已达配额上限，请等待进行中的任务完成')
    }
    this.perUser.set(ownerId, current + 1)
    this.globalInFlight += 1
  }

  // 释放槽位（run 终态 finally 调用）。防御 over-release：未知 owner / 计数已归零 → 告警不抛
  // （闸门错误不应放大为 run 域错误），计数下限 0。
  release(ownerId: string): void {
    const current = this.perUser.get(ownerId) ?? 0
    if (current <= 0) {
      // eslint-disable-next-line no-console
      console.warn(`[runner] run_quota over-release: ownerId=${ownerId}`)
      return
    }
    if (current === 1) this.perUser.delete(ownerId)
    else this.perUser.set(ownerId, current - 1)
    this.globalInFlight = Math.max(0, this.globalInFlight - 1)
  }

  // 观测面（测试 + 运维日志）。
  inFlightFor(ownerId: string): number {
    return this.perUser.get(ownerId) ?? 0
  }

  globalInFlightCount(): number {
    return this.globalInFlight
  }
}
