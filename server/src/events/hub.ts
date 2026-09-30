import type { CatalogEvent } from './logic'
import { encodeFrame } from './logic'

// StreamHub（issue #773）：SSE 连接注册表 + 事件扇出。单进程内 per-user 多条连接
// （多端广播语义，#726），serverSeq 按 user 独立连续单调分配（#726「per-session 连续
// 单调」：流 = per-user 事件序列，同 user 多端各连接收到同一 seq）——客户端 gap 检测
// 与流内去重的游标，见 logic.ts。hub 只面向 StreamSink 接口（Port）——express Response
// 适配在路由层。
//
// 扩展点：后续票 session/run/approval 域事件经 publish 扇出（runner 订阅者 →
// 事件桥 projectStreamEvent → hub.publish）；terminate 由 logout（auth 路由注入）与
// 心跳存活检查（路由层 isActive 复查，#726「用户被吊销 → session.terminated」）触发。

// 连接写出口（Port）：send 返回 false 表示连接已不可写（扇出方据此注销）。
export interface StreamSink {
  send(wire: string): boolean
  close(): void
}

export type TerminateReason = 'logout' | 'revoked'

export class StreamHub {
  // per-user 连续单调游标：每个 user 的事件序列独立编号（#726 per-session 语义），
  // 同 user 的多条连接共享同一游标（多端广播同 seq）。user 的连接全部断开后游标
  // 保留——重连后 lastSeen 语义延续。
  private readonly seqs = new Map<string, number>()
  private readonly conns = new Map<string, Set<StreamSink>>()

  register(userId: string, sink: StreamSink): void {
    let set = this.conns.get(userId)
    if (!set) {
      set = new Set()
      this.conns.set(userId, set)
    }
    set.add(sink)
  }

  unregister(userId: string, sink: StreamSink): void {
    const set = this.conns.get(userId)
    if (!set) return
    set.delete(sink)
    if (set.size === 0) this.conns.delete(userId)
  }

  // 当前高水位 seq（stream.opened 的 serverSeq 来源：建流时刻游标，客户端断线重连后
  // 与本地 lastSeen 比对做 gap 检测——只检测不重放）。
  currentSeq(userId: string): number {
    return this.seqs.get(userId) ?? 0
  }

  // 分配该 user 的下一个 seq（terminate 帧与业务事件共用同一游标，保证客户端视角连续）。
  private nextSeq(userId: string): number {
    const next = (this.seqs.get(userId) ?? 0) + 1
    this.seqs.set(userId, next)
    return next
  }

  // 扇出一帧到指定 user 的全部连接；发送失败（连接死）就地注销。
  private fanOut(userId: string, seq: number, event: CatalogEvent): void {
    const set = this.conns.get(userId)
    if (!set || set.size === 0) return
    const wire = encodeFrame(seq, event)
    for (const sink of [...set]) {
      if (!sink.send(wire)) this.unregister(userId, sink)
    }
  }

  // 发布业务事件（token 事件即焚语义：不落盘、无缓冲，错过即 gap 由客户端投影补偿）。
  publish(userId: string, event: CatalogEvent): void {
    this.fanOut(userId, this.nextSeq(userId), event)
  }

  // 终止该 user 全部连接：广播 session.terminated{reason} 后 close（客户端收帧即
  // 停重连，#726 带内信号语义——401 不可见，吊销走事件）。
  terminate(userId: string, reason: TerminateReason): void {
    this.fanOut(userId, this.nextSeq(userId), {
      type: 'session.terminated',
      payload: { reason },
    })
    const set = this.conns.get(userId)
    if (!set) return
    for (const sink of [...set]) sink.close()
    this.conns.delete(userId)
  }
}
