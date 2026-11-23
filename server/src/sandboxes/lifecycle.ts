// 沙箱生命周期编排（#776 · S2「编排器 Port 延伸」业务层）。
// story 58 最小闭环：惰性创建（首次上传/首次执行时建，#766 D5——由 runner ingestion 节点与
// 执行面调用 ensure；本层只提供 Port，不接 REST）+ 闲置 30 分钟自动 stop（文件保留）+ 删 session
// 级联删（remove；#778 会话 REST 删 session 时调用）。
//
// 串行模型：per-session NameSerializer（进程内，先例：fleet 同 name 串行）——并发 ensure 只
// 落一次 create；ensure 与 remove 同 session 排队，消「create 半途被删」竞态。
//
// 闲置判定：进程内 activity map（ensure/touch 记时间戳）。控制面重启后 map 为空——对 daemon
// 里仍 running 的未知沙箱以「服务启动时刻」为闲置基线（grace：重启后首个 run 会 re-ensure 刷
// 活动时间，重启窗口内不误停）。真 activity 源（run/工具原语 touch）随 #777 runner 接线。
//
// 时钟经构造注入（now），单测推进假时钟；idleMs/limits 可覆盖（smoke 用短阈值/小内存）。

import { NameSerializer } from '../containers/lifecycleQueue'
import type { SandboxInfo, SandboxRuntime } from './runtime'
import {
  SANDBOX_IDLE_STOP_MS,
  SANDBOX_LIMITS,
  SANDBOX_SWEEP_INTERVAL_MS,
  type SandboxLimits,
} from './values'

export interface SandboxLifecycleOptions {
  /** 沙箱镜像（config.sandbox.image） */
  readonly image: string
  /** 资源 limit 覆盖（缺省 SANDBOX_LIMITS 规格初值；smoke 用小值） */
  readonly limits?: SandboxLimits
  /** 闲置 stop 阈值毫秒（缺省 30 分钟；测试/smoke 覆盖） */
  readonly idleMs?: number
  /** 时钟注入（缺省 Date.now；单测假时钟） */
  readonly now?: () => number
}

export type SandboxRemoveOutcome = 'removed' | 'not-found'

export class SandboxLifecycle {
  private readonly serializer = new NameSerializer()
  // sessionId → 最后活动时刻（epoch ms）
  private readonly activity = new Map<string, number>()
  // 已确认回收独立网络的沙箱：稳态下不再对其重复 DELETE（历史沙箱随会话数增长，每轮全量
  // DELETE 会把 sweeper 变成对 daemon 的无效压力）。ensure/fork 重建网络时清除标记。
  private readonly networkReleased = new Set<string>()
  // 服务启动时刻（未知沙箱的闲置基线，见类注释）
  private readonly bootMs: number
  private sweeper: NodeJS.Timeout | null = null

  constructor(
    private readonly runtime: SandboxRuntime,
    private readonly opts: SandboxLifecycleOptions,
  ) {
    this.bootMs = this.now()
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private idleMs(): number {
    return this.opts.idleMs ?? SANDBOX_IDLE_STOP_MS
  }

  // 记活动（闲置计时刷新）。ensure 隐式调用；runner 侧工具原语活动显式调用（#777 接线点）。
  touch(sessionId: string): void {
    this.activity.set(sessionId, this.now())
  }

  // 确保独立网络存在（createNetwork 幂等：已存在复用），并作废「已回收」标记。
  // 复启必须先走这里：闲置回收会删掉网络，而容器 HostConfig.NetworkMode 仍指着它——
  // 直接 start 会被 daemon 以 network not found 拒收（文件还在，但会话起不来）。
  private async ensureNetwork(sessionId: string): Promise<void> {
    await this.runtime.createNetwork(sessionId)
    this.networkReleased.delete(sessionId)
  }

  // 惰性创建 + 确保运行（幂等）：running → 原样返回；stopped → start（文件保留语义：可写层
  // 跨 stop/start 存续）；不存在 → create（网络 + 容器 + /lab 预置）→ start。全部路径刷新活动。
  // 返回值恒为 runtime 实况快照（stopped 复启分支 start 后重查——返回陈旧 running:false 会
  // 误导 #777 消费方）。
  ensure(sessionId: string): Promise<SandboxInfo> {
    return this.serializer.enqueue(sessionId, async () => {
      const existing = await this.runtime.getSandbox(sessionId)
      if (existing !== null) {
        if (!existing.running) {
          await this.ensureNetwork(sessionId) // 闲置回收已删网 → 复启前重建（幂等）
          await this.runtime.startSandbox(sessionId)
          const fresh = await this.runtime.getSandbox(sessionId)
          this.touch(sessionId)
          return fresh ?? { ...existing, running: true, status: 'running' }
        }
        this.touch(sessionId)
        return existing
      }
      // 网络先行（容器建在网络上）；createSandbox 只做容器原语（create + /lab 预置）
      await this.ensureNetwork(sessionId)
      const id = await this.runtime.createSandbox({
        sessionId,
        image: this.opts.image,
        limits: this.opts.limits ?? SANDBOX_LIMITS,
      })
      await this.runtime.startSandbox(sessionId)
      this.touch(sessionId)
      return {
        containerId: id,
        sessionId,
        running: true,
        status: 'running',
        image: this.opts.image,
      }
    })
  }

  // 删 session 级联删（story 58）：容器（可写层 /lab 随之销毁——附件字节随沙箱）+ 独立网络。
  // 不存在 → 'not-found'（幂等，供 #778 级联链安全重试）。
  remove(sessionId: string): Promise<SandboxRemoveOutcome> {
    return this.serializer.enqueue(sessionId, async () => {
      const existing = await this.runtime.getSandbox(sessionId)
      if (existing === null) {
        // 容器不在仍清网络（外部删容器不删网络的泄漏面，对齐 fleet remove 连删卷哲学）
        await this.runtime.removeNetwork(sessionId)
        return 'not-found'
      }
      await this.runtime.removeSandbox(sessionId)
      await this.runtime.removeNetwork(sessionId)
      this.activity.delete(sessionId)
      this.networkReleased.delete(sessionId)
      return 'removed'
    })
  }

  // fork 沙箱（#781 · #768 D7）：源容器字面复制 → 目标沙箱（网络 + 容器 + start）。
  // 源不存在 → 'source-missing' + 目标空起步（常规 createSandbox，/lab 预置空树——「源已删则
  // 空起步 + 系统消息」的容器面；系统消息由调用方落库）。全程 per-session 串行（目标名排队，
  // 与 ensure/remove 同 serializer——并发 fork 只落一次）。返回值 = 复制结果供调用方落系统消息。
  forkSandbox(sourceSessionId: string, newSessionId: string): Promise<'copied' | 'source-missing'> {
    return this.serializer.enqueue(newSessionId, async () => {
      await this.ensureNetwork(newSessionId)
      const spec = {
        sessionId: newSessionId,
        sourceSessionId,
        limits: this.opts.limits ?? SANDBOX_LIMITS,
      }
      const outcome = await this.runtime.createSandboxFromSource(spec)
      if (outcome === 'source-missing') {
        await this.runtime.createSandbox({
          sessionId: newSessionId,
          image: this.opts.image,
          limits: this.opts.limits ?? SANDBOX_LIMITS,
        })
      }
      await this.runtime.startSandbox(newSessionId)
      this.touch(newSessionId)
      return outcome
    })
  }

  // 闲置回收扫描：对 daemon 上仍 running 的沙箱，按「最后活动（未知 → 服务启动时刻）+ 阈值」
  // 判闲置并 stop（文件保留）。返回被 stop 的 sessionId 列表（观测/测试面）。daemon 不可达 →
  // 抛错由 sweeper 吞（下轮重试），不炸进程。
  //
  // stop 之外还回收独立网络：每沙箱独占一个 bridge 网段，而 daemon 默认地址池只有 31 段
  // （172.17–172.31.0.0/16 + 192.168.0–240.0/20；与宿主路由重叠的段不可用）。只 stop 不删网
  // 会让每个闲置会话永久占一段，直至 createNetwork 报「could not find an available,
  //  non-overlapping IPv4 address pool among the defaults」、全面无法开新会话。删网不动容器
  // 可写层，文件保留语义不变；复启由 ensure 重建网络。已停沙箱（含部署前残留、OOM exited）
  // 同样回收——部署后首轮 sweep 即清掉历史泄漏，无需手工清网。
  //
  // 每个沙箱的处置都走 per-session 串行器（与 ensure/remove/fork 同一把锁），且入队后重读
  // 实况：list 快照会陈旧——复启与 sweep 并发时，若按「快照里它是 stopped」直接删网，就会把
  // ensure 刚重建的网络再删掉，复启又落回 network not found。重读后 running → 本轮不动它。
  async sweepIdle(): Promise<string[]> {
    const sandboxes = await this.runtime.listSandboxes()
    const now = this.now()
    const stopped: string[] = []
    for (const s of sandboxes) {
      await this.serializer.enqueue(s.sessionId, async () => {
        const fresh = await this.runtime.getSandbox(s.sessionId)
        if (fresh === null) {
          // 已被 remove（容器 + 网络同清）：只作废本地标记
          this.networkReleased.delete(s.sessionId)
          return
        }
        if (fresh.running) {
          const last = this.activity.get(s.sessionId) ?? this.bootMs
          if (now - last < this.idleMs()) return // 未闲置：容器与网络都不动
          await this.runtime.stopSandbox(s.sessionId)
          stopped.push(s.sessionId)
        } else if (this.networkReleased.has(s.sessionId)) {
          return // 已停且网络已回收：无重复 DELETE
        }
        await this.releaseNetwork(s.sessionId)
      })
    }
    return stopped
  }

  // 回收沙箱独立网络（尽力而为）：单个失败只告警、不中断本轮其余沙箱回收，且不记回收标记，
  // 下一轮 sweep 重试。stop 已成功，删网失败不应让整轮扫描报废（daemon 抖动/残留 endpoint）。
  private async releaseNetwork(sessionId: string): Promise<void> {
    try {
      await this.runtime.removeNetwork(sessionId)
      this.networkReleased.add(sessionId)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[sandboxes] idle network release failed: session=${sessionId} ${(e as Error).message}`)
    }
  }

  // 启动周期 sweeper（生产装配；unref 不阻进程退出）。返回停止句柄。
  startIdleSweeper(intervalMs = SANDBOX_SWEEP_INTERVAL_MS): () => void {
    if (this.sweeper !== null) return () => {} // 幂等：重复启动只保一个
    const timer = setInterval(() => {
      this.sweepIdle().catch((e) => {
        // daemon 故障不炸进程：下轮重试（对齐 fleet reconcile 的容忍面）
        // eslint-disable-next-line no-console
        console.warn(`[sandboxes] idle sweep failed: ${(e as Error).message}`)
      })
    }, intervalMs)
    timer.unref()
    this.sweeper = timer
    return () => {
      clearInterval(timer)
      this.sweeper = null
    }
  }
}
