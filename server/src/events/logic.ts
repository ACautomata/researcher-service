// SSE 帧编码与 Last-Event-ID/gap 语义（纯逻辑，接缝 S3，issue #773）。
// 帧格式准据 = #747 C 节 / #726 resolution：
//   id: <seq>            —— per-user 连续单调 serverSeq（hub 分配，见 hub.ts）
//   event: <type>        —— 事件目录类型名（values.ts）
//   data: <json>         —— {type, sessionId?, runId?, payload}
//   心跳 = SSE 注释帧 :ping（20s，间隔在路由层消费 HEARTBEAT_MS）
// 断线补偿语义（#726）：Last-Event-ID/seq 只检测 gap 与流内去重、**不重放**——
// token 事件即焚不落盘，无缓冲可重放；补偿 = 客户端重拉投影（#727 投影面）。
// 下方 parseLastEventId/detectGap/isDuplicateInStream 是 **客户端判定语义的参考实现**：
// 服务端不读 Last-Event-ID（routes.ts 头注），但 AC③「gap 检测不重放行为有测试锁定」
// 要求把判定语义钉死在 S3——前端票（#730）落地 EventSource 客户端时按此移植，
// 防两端实现漂移。与本票 bridge.ts（runner 后续票消费）同为「骨架先行」的零调用骨架。

// 事件目录事件（#747 C 节）：传输层只认这一形状，不关心具体域。
// sessionId/runId 仅会话域/run 域事件携带，连接域事件缺省。
export interface CatalogEvent {
  readonly type: string
  readonly sessionId?: string
  readonly runId?: string
  readonly payload: unknown
}

// 编码一帧 SSE 线格式（单连接写入口的唯一编码路径，路由层原样 res.write）。
export function encodeFrame(seq: number, event: CatalogEvent): string {
  const data = JSON.stringify({
    type: event.type,
    ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    payload: event.payload,
  })
  return `id: ${seq}\nevent: ${event.type}\ndata: ${data}\n\n`
}

// 心跳帧：SSE 注释（以冒号开头），EventSource 不触发任何事件回调。
export function encodePing(): string {
  return ':ping\n\n'
}

// 解析 Last-Event-ID 请求头（EventSource 重连时携带的最后一个 id）。
// 输入 0 信任：任何非法形态（非数值/负/小数/空白/超安全整数）→ null = 无线索，
// 绝不回溯信任、绝不抛错（坏头不能打断建流）。
export function parseLastEventId(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) return null
  return n
}

// gap 判定（客户端在收 stream.opened 后比对 lastSeen vs payload.serverSeq，#726 补偿流）：
//   'gap'         —— serverSeq 推进过（断线期间有事件发布）或回退过（重启/换实例，
//                   内存 seq 归零）——两种都不可声称连续，客户端走投影重拉补偿
//   'contiguous'  —— 与本地游标齐平，断线期间零事件
//   'fresh'       —— 客户端无 lastSeen（首连/新标签页），常规加载投影
// 本函数不做任何重放决策——服务端无缓冲，重放语义不存在（#726 钉死）。
export function detectGap(lastSeenSeq: number | null, serverSeq: number): 'gap' | 'contiguous' | 'fresh' {
  if (lastSeenSeq === null) return 'fresh'
  return serverSeq === lastSeenSeq ? 'contiguous' : 'gap'
}

// 流内去重：seq 单调前提（hub 全局单点分配）下，seq ≤ 已应用游标即为重复帧，
// 幂等消费（多端/重叠重连窗口下同一事件可能已应用），丢弃且不推进游标。
export function isDuplicateInStream(seq: number, lastAppliedSeq: number | null): boolean {
  if (lastAppliedSeq === null) return false
  return seq <= lastAppliedSeq
}
