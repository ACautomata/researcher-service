// run 并发闸门（#775，731 §5.3 + #747 F 节「配额」）。
//
// 分层（731 §5.3 推荐分层表）：
//   per-user 在飞 run 并发 —— users.maxConcurrentRuns 列 + 进程内计数器（Map<ownerId, n>）
//   全局在飞 run 并发     —— env RUNNER_MAX_CONCURRENT_RUNS（config.runner.maxConcurrentRuns）
//   LLM 速率/token 限流   —— 首期不做（usage 全量采数，出现滥用再加；见 runner/usage.ts）
//
// 为什么进程内原语：BullMQ 原生 limiter 的 per-user 组限流（groupKey）自 3.0 起是 Pro 专属
// （OSS 移除），Bottleneck 等第三方库维护停滞；#734 Notes 钉「BullMQ+Redis 为单进程模型」——
// 进程内计数器即正确的分布式边界。未来 runner 多副本时把两个计数器换 Redis Lua 原子
// INCR/DECR（接口不变，实现替换——本文件的 RunLease/acquire 面即为此稳定）。
//
// 满 → EnvelopeError 40043（并发配额已满）；run 结束 finally 释放（lease.release 幂等 +
// 持有者崩溃随 task 取消由调用方 finally 兜底）。teammate 按会话计不额外占额度、figure 生成
// 随会话 run 占额度（#747 F 节）——即本闸门只按「run」计数，计数主体的定义归 runner 编排票
//（#777）对接，本模块不感知 run 种类。

import { fail } from '../envelope'
import { CODE } from '../codes'

// run 租约：release 幂等（重复调 / 崩溃后调均安全）。
export interface RunLease {
  release(): void
}

// per-user 配额来源（生产 = prisma.user.findUnique({maxConcurrentRuns})；测试注 fake——
// 用户配额可被 admin 改，取额度须走即时读而非构造期快照）。
export type UserRunLimitLoader = (ownerId: string) => Promise<number>

export interface ConcurrencyGateOptions {
  /** 全局在飞上限（env RUNNER_MAX_CONCURRENT_RUNS；config 注入） */
  readonly globalLimit: number
  /** per-user 在飞上限即时读（users.maxConcurrentRuns） */
  readonly loadUserLimit: UserRunLimitLoader
}

interface GateState {
  readonly perUser: Map<string, number>
  globalCount: number
}

export class ConcurrencyGate {
  private readonly state: GateState = { perUser: new Map(), globalCount: 0 }

  constructor(private readonly opts: ConcurrencyGateOptions) {
    if (!Number.isInteger(opts.globalLimit) || opts.globalLimit <= 0) {
      throw new Error(`globalLimit 非法: ${opts.globalLimit}（须为正整数——config 层已校验，此处防御）`)
    }
  }

  // 取闸门：满 → 40043。await 点只有额度读取一处——两个闸门的「检查 + 自增」都排在 await
  // 之后、彼此紧邻（JS 单线程，无 interleaving 窗口）；若把全局检查放在 await 之前则与自增
  // 之间隔着 loadUserLimit 的 await，并发 acquire 会集体越过检查（check-then-act 竞态——
  // Spec 评审 R2 实证：globalLimit=2 时 10 并发全放行）。顺序：全局先查（runaway 最后防线，
  // 也更便宜），per-user 后查（额度即读即用，admin 中途上调即刻生效）。
  async acquire(ownerId: string): Promise<RunLease> {
    const userLimit = await this.opts.loadUserLimit(ownerId)
    if (!Number.isInteger(userLimit) || userLimit < 0) {
      // 配额列坏值（理论不可达）：视作 0 保护面（拒绝）而非放行
      throw fail(CODE.CONCURRENCY_QUOTA_EXCEEDED, '用户并发配额配置非法')
    }
    if (this.state.globalCount >= this.opts.globalLimit) {
      throw fail(CODE.CONCURRENCY_QUOTA_EXCEEDED, '全局并发已满，请稍后再试')
    }
    if ((this.state.perUser.get(ownerId) ?? 0) >= userLimit) {
      throw fail(CODE.CONCURRENCY_QUOTA_EXCEEDED)
    }
    this.state.globalCount += 1
    this.state.perUser.set(ownerId, (this.state.perUser.get(ownerId) ?? 0) + 1)
    let released = false
    return {
      release: () => {
        if (released) {
          // over-release 可观测面（#812 打捞 #809）：幂等不抛（闸门错误不放大为 run 域错误），
          // 但告警留痕——finally 双释放等纪律失守在日志可见。
          // eslint-disable-next-line no-console
          console.warn(`[runner] run-quota over-release: ownerId=${ownerId}（lease 重复释放已忽略）`)
          return
        }
        released = true
        this.state.globalCount -= 1
        const n = (this.state.perUser.get(ownerId) ?? 1) - 1
        if (n <= 0) this.state.perUser.delete(ownerId)
        else this.state.perUser.set(ownerId, n)
      },
    }
  }

  // 便捷封装：acquire → fn → finally release（run 编排的纪律用法，防漏释放）。
  async runWithLease<T>(ownerId: string, fn: () => Promise<T>): Promise<T> {
    const lease = await this.acquire(ownerId)
    try {
      return await fn()
    } finally {
      lease.release()
    }
  }

  // 观测面（测试/健康检查；非产品 API）。
  inFlight(ownerId?: string): number {
    return ownerId === undefined ? this.state.globalCount : this.state.perUser.get(ownerId) ?? 0
  }
}
