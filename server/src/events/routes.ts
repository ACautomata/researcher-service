import { Router, type Request, type Response } from 'express'
import { CODE, defaultMessage } from '../codes'
import { PANEL_STREAM_COOKIE } from '../config'
import { verifyPanelStreamToken } from '../auth/tokens'
import type { StreamHub, StreamSink } from './hub'
import { encodeFrame, encodePing } from './logic'
import { SSE_PROTOCOL_V, HEARTBEAT_MS } from './values'

// GET /api/v1/events（issue #773，#747 C 节）：每标签页一条单工 SSE 流，全面替代 WS。
// 认证 = panel_stream cookie 专属只读通道（#726：HttpOnly/SameSite=Strict/Path 锁本端点，
// 写面零 CSRF 暴露）；连接级认证失败走 HTTP 401 不入事件（#726 钉死——EventSource 看不见
// 状态码，401 语义是给 REST 刷新链的死信号让路）。Bearer 一律不接受（EventSource 本就
// 不能带 header，收了反而制造第二认证面）。
//
// 断线语义（#726）：Last-Event-ID 只作客户端 gap 检测素材，服务端不读、不重放——
// token 事件即焚，补偿 = 客户端重拉投影。心跳 :ping 20s 兼做存活复查：用户被吊销 →
// 下一拍 session.terminated{reason:'revoked'} + 关连接（带内信号，客户端停重连）。

export interface EventsRouterDeps {
  // 事件扇出注册表（生产 server.ts 装配单例；测试注入同一 hub 触发 publish/terminate）。
  readonly hub: StreamHub
  // 心跳间隔（缺省 HEARTBEAT_MS=20s，#747 C 节锁；测试注入缩短避免等 20s）。
  readonly heartbeatMs?: number
}

function rejectUnauthenticated(res: Response): void {
  res.status(401).json({ code: CODE.UNAUTHENTICATED, message: defaultMessage(CODE.UNAUTHENTICATED), data: null })
}

export function createEventsRouter(deps: EventsRouterDeps): Router {
  const router = Router()
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS

  router.get('/', async (req: Request, res: Response) => {
    const token = req.cookies?.[PANEL_STREAM_COOKIE]
    if (typeof token !== 'string') {
      rejectUnauthenticated(res)
      return
    }
    let userId: string
    try {
      userId = (await verifyPanelStreamToken(token)).userId
    } catch {
      rejectUnauthenticated(res)
      return
    }
    const user = await req.prisma.user.findUnique({ where: { id: userId } })
    if (!user || !user.isActive) {
      rejectUnauthenticated(res)
      return
    }

    // SSE 响应头：X-Accel-Buffering 禁 nginx 代理层攒帧（应用层 Belt；部署清单
    // frontend/nginx.conf 的 proxy_buffering off 是 Braces，两侧同步锁）。
    res.status(200)
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders()

    const sink: StreamSink = {
      send: (wire) => {
        if (res.writableEnded) return false
        res.write(wire)
        return true
      },
      close: () => {
        if (!res.writableEnded) res.end()
      },
    }
    deps.hub.register(userId, sink)

    // 建流首帧：stream.opened{protocolV, serverSeq, serverTime}（连接域事件骨架）。
    // serverSeq = 该 user 建流时刻高水位（per-user 连续单调，#726「per-session」语义）：
    // 客户端断线重连后（EventSource 自动带 Last-Event-ID）与本地 lastSeen 比对做 gap
    // 检测——服务端不读该头、不参与重放决策（无缓冲，token 事件即焚；gap/流内去重判定
    // 在客户端，纯函数镜像见 logic.ts parseLastEventId/detectGap/isDuplicateInStream）。
    const openedSeq = deps.hub.currentSeq(userId)
    sink.send(
      encodeFrame(openedSeq, {
        type: 'stream.opened',
        payload: { protocolV: SSE_PROTOCOL_V, serverSeq: openedSeq, serverTime: new Date().toISOString() },
      }),
    )

    // 心跳 :ping + 存活复查共用一拍：被吊销（admin 禁用）→ session.terminated{revoked}
    // 并关连接（hub.terminate 广播该 user 全部连接）；单进程控制面下每连接每拍一次
    // isActive 查询可承受，连接数上量后再改事件驱动。
    const timer = setInterval(() => {
      void (async () => {
        try {
          const u = await req.prisma.user.findUnique({
            where: { id: userId },
            select: { isActive: true },
          })
          if (!u || !u.isActive) {
            deps.hub.terminate(userId, 'revoked')
            return
          }
          sink.send(encodePing())
        } catch {
          // 复查查询失败不杀流：下一拍重试（保守——错误方向是流多活 20s，不是误踢）
        }
      })()
    }, heartbeatMs)
    timer.unref?.()

    req.on('close', () => {
      clearInterval(timer)
      deps.hub.unregister(userId, sink)
    })
  })

  return router
}
