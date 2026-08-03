// #337 M5 验收第二条（ADR 0006 B-直连）：浏览器侧官方 `@openclaw/gateway-client/browser` 协议机
// 经自定义 transport（面板隧道 socket）→ 后端隧道（真实 http server + makeWsGatewayConnector）
// → fake 容器网关（真实 ws server），对网关完成 protocol v4 握手并收发原始帧。
//
// 证据链：
//   1. 协议机 buildConnectParams 产出的 connect req 帧**原样**到达网关（隧道零解析/零翻译）；
//   2. 网关回 challenge / hello-ok，协议机按 v4 状态机成功握手上（onHello 收到 hello-ok）。
// 本测试中的 NodeTunnelSocket 与前端 src/chat/tunnelSocket.ts 同构（同一 GatewayProtocolSocket
// 接口），证明前端「自定义 transport 跑官方协议机」形态成立。协议机握手/重连/会话投影为官方包
// 职责（#331 测试决策豁免），此处只验证「经隧道承载」这一本切片接缝。

import { describe, it, expect } from 'vitest'
import http, { type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { WebSocketServer, WebSocket } from 'ws'
// server 是 commonjs + moduleResolution:node（node10），解析不了该 ESM 包的 .mts 类型（前端用
// @vue/tsconfig 的 bundler resolution 才可，见 frontend/src/chat/tunnelSocket.ts）。集成测试运行时
// 经 vitest/Vite 正常加载（exports import 条件）；此处抑制 TS2307 以不污染全局 tsconfig。
// @ts-expect-error —— ESM-only 包，node10 moduleResolution 无 .mts 类型
import { GatewayProtocolClient } from '@openclaw/gateway-client/browser'
import { createPrismaClient } from '../src/prisma'
import { signAccessToken } from '../src/auth/tokens'
import { seedUser } from './helpers'
import { createTunnelServer, type TunnelDeps } from '../src/chat/tunnel'
import { makeWsGatewayConnector } from '../src/chat/gatewayConnector'
import type { PrismaClient } from '../src/generated/prisma/client'

const INIT_SQL = readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8')

// 协议机配置的本地最小类型（server node10 resolution 拿不到官方 .mts 类型，用最小接口约束回调参数）
interface TunnelSocketHandlers {
  open: () => void
  message: (data: string) => void
  close: (code: number, reason: string) => void
  error: (err: Error) => void
}
interface ConnectPlan {
  role: string
  scopes: string[]
  caps: string[]
  token: string
}

// 浏览器侧面板隧道 socket 的 Node 版（与 frontend/src/chat/tunnelSocket.ts 同构）：
// 连 /ws/chat/?container= 隧道，JWT subprotocol，事件映射到协议机 handlers。
class NodeTunnelSocket {
  private readonly ws: WebSocket
  constructor(url: string, jwt: string, handlers: TunnelSocketHandlers) {
    this.ws = new WebSocket(url, ['access_token', jwt])
    this.ws.on('open', () => handlers.open())
    this.ws.on('message', (data) => handlers.message(data.toString()))
    this.ws.on('close', (code, reason) => handlers.close(code, reason.toString()))
    this.ws.on('error', (err) => handlers.error(err))
  }
  isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN
  }
  send(data: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data)
  }
  close(code?: number, reason?: string): void {
    this.ws.close(code, reason)
  }
}

describe('M5 协议机经隧道 v4 握手（#337 验收②）', () => {
  it('官方 ./browser 协议机经隧道连网关完成 connect，隧道零解析原样透传', async () => {
    // --- fake 容器网关（真实 ws server）：发 challenge → 收 connect req → 回 hello-ok ---
    const gatewayFrames: string[] = [] // 网关收到的帧（= 浏览器协议机发出的原帧）
    let connectParams: unknown = null
    const gserver = http.createServer()
    const wss = new WebSocketServer({ noServer: true })
    wss.on('connection', (gw) => {
      // 网关一建立即发 connect.challenge（对齐官方：握手须先取 nonce）
      gw.send(
        JSON.stringify({
          type: 'event',
          event: 'connect.challenge',
          payload: { nonce: 'test-nonce', ts: Date.now() },
          seq: 1,
        }),
      )
      gw.on('message', (data) => {
        const raw = data.toString()
        gatewayFrames.push(raw)
        const frame = JSON.parse(raw) as { id?: string; method?: string }
        if (frame.method === 'connect') {
          connectParams = (JSON.parse(raw) as { params?: unknown }).params
          // hello-ok：下发 deviceToken + role + scopes + policy（协议机 connect 的 res ok payload）
          gw.send(
            JSON.stringify({
              type: 'res',
              id: frame.id,
              ok: true,
              payload: {
                auth: { deviceToken: 'test-device-token', role: 'operator', scopes: ['operator.read', 'operator.write'] },
                policy: { maxPayload: 4096, maxBufferedBytes: 4096, tickIntervalMs: 30000 },
              },
            }),
          )
        }
      })
    })
    gserver.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    })
    await new Promise<void>((resolve) => gserver.listen(0, '127.0.0.1', resolve))
    const { port: gatewayPort } = gserver.address() as AddressInfo

    // --- 后端隧道：真实 http server + makeWsGatewayConnector，容器行 port 指向 fake 网关 ---
    const dir = mkdtempSync(path.join(tmpdir(), `tunnelp-${process.pid}-`))
    const sqlite = new Database(path.join(dir, 't.db'))
    sqlite.exec(INIT_SQL)
    sqlite.close()
    const prisma: PrismaClient = createPrismaClient(`file:${path.join(dir, 't.db')}`)
    const user = await seedUser(prisma)
    const jwt = await signAccessToken(user.id)
    await prisma.container.create({
      data: {
        name: 'alpha',
        port: gatewayPort, // 指向 fake 网关宿主端口
        ownerId: user.id,
        token: 'enc',
        tokenEncrypted: false,
        homeDir: '/tmp/alpha-home',
        status: 'running',
        image: 'ghcr.io/openclaw/openclaw:2026.7.1-browser',
      },
    })
    const deps: TunnelDeps = {
      prisma,
      connectGateway: makeWsGatewayConnector(),
      gatewayHost: '127.0.0.1',
    }
    const tunnel = createTunnelServer(deps)
    const server: Server = http.createServer()
    server.on('upgrade', (req, socket, head) => {
      if (!tunnel.handleUpgrade(req, socket, head)) socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port: tunnelPort } = server.address() as AddressInfo
    const tunnelUrl = `ws://127.0.0.1:${tunnelPort}/ws/chat/?container=alpha`

    try {
      // --- 浏览器侧官方协议机：自定义 transport（NodeTunnelSocket）注入 createSocket ---
      let requestSeq = 0
      const hellos: unknown[] = []
      const client = new GatewayProtocolClient<ConnectPlan>({
        createSocket: (handlers: TunnelSocketHandlers) => new NodeTunnelSocket(tunnelUrl, jwt, handlers),
        createRequestId: () => `test-req-${requestSeq++}`,
        buildConnectPlan: async () => ({
          role: 'operator',
          scopes: ['operator.read', 'operator.write'],
          caps: ['tool-events'],
          token: 'bootstrap-token', // 首连 bootstrap 凭证（#338 发放；此处直接注入）
        }),
        buildConnectParams: (plan: ConnectPlan) => ({
          minProtocol: 4,
          maxProtocol: 4,
          client: { id: 'webchat-ui', mode: 'webchat', platform: 'browser', version: '2026.7.2-beta.6' },
          role: plan.role,
          scopes: plan.scopes,
          caps: plan.caps,
          auth: { token: plan.token },
        }),
        handshake: { mode: 'require-challenge', timeoutMs: 3000 },
        reconnect: { initialMs: 100, multiplier: 2, maxMs: 1000 },
        // close 决策：测试里隧道不应意外关闭；真断开按官方协议机默认重连语义
        resolveClose: () => ({ retry: true, notify: true, reconnectDelayMs: 200 }),
        onHello: (hello: unknown) => hellos.push(hello),
      })
      client.start()

      // 等协议机完成 v4 握手（hello-ok）
      const deadline = Date.now() + 3000
      while (hellos.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }

      // 断言 1：协议机完成握手（onHello 收到 hello-ok，含网关下发的 deviceToken）
      expect(hellos.length).toBe(1)
      expect((hellos[0] as { auth?: { deviceToken?: string } }).auth?.deviceToken).toBe('test-device-token')

      // 断言 2：connect req 帧原样到达网关（隧道零解析），params 即 buildConnectParams 输出
      expect(connectParams).not.toBeNull()
      const p = connectParams as { role: string; scopes: string[]; caps: string[]; auth: { token: string } }
      expect(p.role).toBe('operator')
      expect(p.scopes).toEqual(['operator.read', 'operator.write'])
      expect(p.caps).toEqual(['tool-events'])
      expect(p.auth.token).toBe('bootstrap-token') // 隧道不注入/不替换凭证，原样透传

      client.stop()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await new Promise<void>((resolve) => gserver.close(() => resolve()))
      await prisma.$disconnect()
    }
  }, 10_000)
})
