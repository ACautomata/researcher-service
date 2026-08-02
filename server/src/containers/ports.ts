// 宿主端口池分配（平移 backend/containers/ports.py，#334）。
// 容器内统一 18789（Docker 网络命名空间隔离），仅宿主侧分配映射端口。
// 池默认 [19000, 19999]（避开被单容器 compose 占用的 18789），取最小空闲，耗尽抛错。
// 纯逻辑、无 IO：调用方传入「已用端口集合」，allocator 返回池内最小空闲端口。

import { GATEWAY_INTERNAL_PORT } from './constants'
import { PortPoolExhausted } from './errors'

// 单容器 compose 栈占用（127.0.0.1:18789:18789）；端口值单一来源 = GATEWAY_INTERNAL_PORT
export const RESERVED_PORT_18789 = GATEWAY_INTERNAL_PORT

export class PortAllocator {
  private readonly start: number
  private readonly end: number
  private readonly reserved: ReadonlySet<number>

  constructor(start: number, end: number, reserved: Iterable<number> = []) {
    if (end < start) throw new Error('端口池 end 不得小于 start')
    this.start = start
    this.end = end
    this.reserved = new Set(reserved)
  }

  // 从 [start, end] 闭区间取最小空闲端口，跳过 reserved 与已用；耗尽抛 PortPoolExhausted（90004）
  nextFree(used: Iterable<number>): number {
    const usedSet = new Set(used)
    for (let port = this.start; port <= this.end; port += 1) {
      if (this.reserved.has(port) || usedSet.has(port)) continue
      return port
    }
    throw new PortPoolExhausted(
      `端口池 ${this.start}-${this.end} 已耗尽（reserved=${[...this.reserved].sort((a, b) => a - b)}）`,
    )
  }
}
