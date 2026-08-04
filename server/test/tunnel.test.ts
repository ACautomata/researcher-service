// #337 M5 对话桥接核心（ADR 0006 隧道形态）——测试接缝 3 WS 桥。
// 真实 http server + 真实 ws 客户端（Node ws 库）拨 upgrade，注入 fake 容器网关：
//   - 握手：两格式 subprotocol 原样回显、authenticate() 同源验签、归属门（越权/不存在 4401）
//   - 拒绝：无效/过期 token → accept-then-close(4401)；网关不可达 → 4402
//   - 透传：浏览器↔网关原始帧字节级原样（零解析/零翻译的强证据：长文本/emoji 逐字节一致）
//
// 协议 v4 握手/重连/会话投影由官方包（浏览器侧）负责，本测试不测协议机，只测隧道承载字节。
// 每用例独立 ctx（真实 http server + 临时 SQLite + fake 网关），try/finally 清理——不共享
// 模块级 ctx（「容器网关不可达」曾替换共享 ctx 污染后续用例，改为自建更稳）。

import { describe, it, expect } from 'vitest'
import http, { type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import WebSocket, { type RawData } from 'ws'
import { SignJWT } from 'jose'
import { createSecretKey } from 'node:crypto'
import { createPrismaClient } from '../src/prisma'
import { signAccessToken } from '../src/auth/tokens'
import { seedUser } from './helpers'
import { config } from '../src/config'
import type { PrismaClient, User } from '../src/generated/prisma/client'
import { createTunnelServer, type TunnelDeps, type TunnelServer } from '../src/chat/tunnel'
import type { GatewayConnector, GatewaySocket } from '../src/chat/gatewayConnector'

const INIT_SQL = readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8')

// --- fake 容器网关（内存双端：send=后端转发来的浏览器帧；fireMessage=模拟网关发帧）---
class FakeGateway implements GatewaySocket {
  received: string[] = [] // 后端→网关（= 浏览器发出的原帧）
  closed = false // 网关侧 close 被调用（浏览器断开 → 后端清理）
  closedCode: number | null = null
  closedReason = ''
  private msgCb: ((data: string) => void) | null = null
  private closeCb: ((code: number, reason: string) => void) | null = null
  send(data: string): void {
    this.received.push(data)
  }
  close(code?: number, reason?: string): void {
    this.closed = true
    this.closedCode = code ?? null
    this.closedReason = reason ?? ''
  }
  onOpen(_cb: () => void): void {
    // 测试不需要模拟网关 open 事件
  }
  onMessage(cb: (data: string) => void): void {
    this.msgCb = cb
  }
  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCb = cb
  }
  onError(_cb: (err: Error) => void): void {
    // 测试不触发网关传输错误（网关不可达经 connector reject 覆盖）
  }
  fireMessage(data: string): void {
    this.msgCb?.(data)
  }
  fireClose(code: number): void {
    this.closeCb?.(code, '')
  }
}

function fakeConnector(gateway: FakeGateway, fail = false): GatewayConnector {
  return {
    connect: async () => {
      if (fail) throw new Error('ECONNREFUSED 127.0.0.1')
      return gateway
    },
  }
}

// --- 测试装配：临时 SQLite + 真实 http server + 隧道 ---
interface TunnelCtx {
  prisma: PrismaClient
  server: Server
  gateway: FakeGateway
  baseUrl: string
  tunnel: TunnelServer // 暴露 close()（优雅关闭测试用）
  close: () => Promise<void>
}

let seq = 0
async function startTunnel(opts: { failGateway?: boolean; connectGateway?: GatewayConnector } = {}): Promise<TunnelCtx> {
  const dir = mkdtempSync(path.join(tmpdir(), `tunnel-${process.pid}-${seq++}-`))
  const sqlite = new Database(path.join(dir, 't.db'))
  sqlite.exec(INIT_SQL)
  sqlite.close()
  const prisma = createPrismaClient(`file:${path.join(dir, 't.db')}`)
  const gateway = new FakeGateway()
  const deps: TunnelDeps = {
    prisma,
    connectGateway: opts.connectGateway ?? fakeConnector(gateway, opts.failGateway),
    gatewayHost: '127.0.0.1',
  }
  const tunnel = createTunnelServer(deps)
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => {
    if (!tunnel.handleUpgrade(req, socket, head)) socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    prisma,
    server,
    gateway,
    tunnel,
    baseUrl: `ws://127.0.0.1:${port}/ws/chat/`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await prisma.$disconnect()
    },
  }
}

async function seedContainer(prisma: PrismaClient, owner: User, name = 'alpha', port = 19001): Promise<void> {
  await prisma.container.create({
    data: {
      name,
      port,
      ownerId: owner.id,
      token: 'enc', // 隧道不读 token（不注入凭证）；bootstrap token 发放属 #338
      tokenEncrypted: false,
      homeDir: '/tmp/alpha-home',
      status: 'running',
      image: 'ghcr.io/openclaw/openclaw:2026.7.1-browser',
    },
  })
}

// 每用例自建 ctx + 属主 user + 合法 jwt + 一个 running 容器（alpha，端口 19001）
async function makeAlphaCtx(opts: { failGateway?: boolean } = {}): Promise<{ ctx: TunnelCtx; user: User; jwt: string }> {
  const ctx = await startTunnel(opts)
  const user = await seedUser(ctx.prisma)
  const jwt = await signAccessToken(user.id)
  await seedContainer(ctx.prisma, user)
  return { ctx, user, jwt }
}

// ws 客户端 helper：连隧道并等 open；失败 reject。protocols 可选（无 subprotocol 场景，Node ws 支持）
function connectTunnel(url: string, protocols?: string | string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = protocols === undefined ? new WebSocket(url) : new WebSocket(url, protocols)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

// 等待异步条件（ws 帧转发/close 事件）
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function collectMessages(ws: WebSocket): string[] {
  const out: string[] = []
  ws.on('message', (data: RawData) => out.push(data.toString()))
  return out
}

// 收集 close 事件（含 code/reason）
function collectClose(ws: WebSocket): { code: number; reason: string }[] {
  const out: { code: number; reason: string }[] = []
  ws.on('close', (code, reason) => out.push({ code, reason: reason.toString() }))
  return out
}

describe('M5 隧道（#337 · ADR 0006）', () => {
  it('两值格式 [' + "'access_token', <jwt>]" + ' 握手成功，subprotocol 原样回显 access_token', async () => {
    const { ctx, jwt } = await makeAlphaCtx()
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      expect(ws.protocol).toBe('access_token')
      ws.close()
    } finally {
      await ctx.close()
    }
  })

  it('单值格式 [' + "'access_token.<jwt>'" + '] 握手成功，subprotocol 原样回显单值（不能硬编码 access_token）', async () => {
    const { ctx, jwt } = await makeAlphaCtx()
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, [`access_token.${jwt}`])
      expect(ws.protocol).toBe(`access_token.${jwt}`)
      ws.close()
    } finally {
      await ctx.close()
    }
  })

  it('无效 token → accept 后 close(4401)', async () => {
    const { ctx } = await makeAlphaCtx()
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', 'bad-token'])
      const closes = collectClose(ws)
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(4401)
    } finally {
      await ctx.close()
    }
  })

  it('过期 token → accept 后 close(4401)（验签与 REST 同源）', async () => {
    const { ctx, user } = await makeAlphaCtx()
    try {
      // 对齐 tokens.ts 私有 ISSUER/AUDIENCE 签发 exp 已过的 HS256 token
      const secret = createSecretKey(Buffer.from(config.jwtSecret))
      const expired = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setIssuer('openclaw-panel')
        .setAudience('openclaw-panel-users')
        .setSubject(user.id)
        .setExpirationTime('-1h')
        .setJti('expired-jti')
        .sign(secret)
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', expired])
      const closes = collectClose(ws)
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(4401)
    } finally {
      await ctx.close()
    }
  })

  it('越权（他人容器）→ close(4401)；不存在容器 → close(4401)（同码防探测）', async () => {
    const { ctx, jwt } = await makeAlphaCtx()
    try {
      const other = await seedUser(ctx.prisma, 'user2')
      await seedContainer(ctx.prisma, other, 'beta', 19002)
      const otherJwt = await signAccessToken(other.id)

      // 越权：user2 连 user 的 alpha 容器
      const ws1 = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', otherJwt])
      const closes1 = collectClose(ws1)
      await until(() => closes1.length > 0)
      expect(closes1[0].code).toBe(4401)

      // 不存在：合法 token 连 ghost 容器
      const ws2 = await connectTunnel(`${ctx.baseUrl}?container=ghost`, ['access_token', jwt])
      const closes2 = collectClose(ws2)
      await until(() => closes2.length > 0)
      expect(closes2[0].code).toBe(4401)
    } finally {
      await ctx.close()
    }
  })

  it('容器名缺失 → close(4401)', async () => {
    const { ctx, jwt } = await makeAlphaCtx()
    try {
      const ws = await connectTunnel(ctx.baseUrl, ['access_token', jwt])
      const closes = collectClose(ws)
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(4401)
    } finally {
      await ctx.close()
    }
  })

  it('无 subprotocol 声明 → accept 后 close(4401)（对齐现状「无 subprotocol 地 accept」）', async () => {
    const { ctx } = await makeAlphaCtx()
    try {
      // 不传 protocols：客户端未声明 access_token → handleProtocols 不选 subprotocol 仍 accept，
      // token 校验层（parseProtocolToken(undefined) → null）决定 4401
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`)
      const closes = collectClose(ws)
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(4401)
    } finally {
      await ctx.close()
    }
  })

  it('容器网关不可达 → close(4402)（非认证问题，区别于 4401）', async () => {
    const { ctx, jwt } = await makeAlphaCtx({ failGateway: true })
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      const closes = collectClose(ws)
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(4402)
    } finally {
      await ctx.close()
    }
  })

  it('mustChangePassword 用户 → close(4403)（authorization-gate-parity：与 REST mustChangePasswordGate 同源，防隧道绕过强制改密）', async () => {
    const ctx = await startTunnel()
    const user = await seedUser(ctx.prisma, 'must-change', 'pw-secure', { mustChangePassword: true })
    const jwt = await signAccessToken(user.id)
    await seedContainer(ctx.prisma, user)
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      const closes = collectClose(ws)
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(4403) // 独立于 4401：token 有效但授权未就绪，不按凭证过期 forceRefresh
    } finally {
      await ctx.close()
    }
  })

  it('网关连接窗口内缓冲超预算 → close(1008)（resource-exhaustion：防异常客户端狂发帧内存无界）', async () => {
    const gateway = new FakeGateway()
    const ctx = await startTunnel({
      connectGateway: {
        connect: async () => {
          await new Promise((r) => setTimeout(r, 150)) // 拉长 pending 窗口
          return gateway
        },
      },
    })
    const user = await seedUser(ctx.prisma)
    const jwt = await signAccessToken(user.id)
    await seedContainer(ctx.prisma, user)
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      const closes = collectClose(ws)
      // 网关连接建立（150ms 延迟）前狂发帧，累计超过 256KB 预算
      const chunk = 'x'.repeat(1024 * 16) // 16KB/帧
      for (let i = 0; i < 20; i++) ws.send(chunk) // 320KB > 256KB
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(1008)
    } finally {
      await ctx.close()
    }
  })

  it('浏览器帧 → 网关原样收到；网关帧 → 浏览器原样收到（字节级零解析，长文本/emoji 无损）', async () => {
    const { ctx, jwt } = await makeAlphaCtx()
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      const browserReceived = collectMessages(ws)

      // v4 握手字节流回放：浏览器发 connect req → 网关逐字节收到
      const connectReq =
        '{"type":"req","id":"r1","method":"connect","params":{"minProtocol":4,"maxProtocol":4,"client":{"id":"gateway-client","mode":"webchat","platform":"browser","version":"2026.7.2-beta.6"},"role":"operator","scopes":["operator.read","operator.write"],"caps":["tool-events"]}}'
      ws.send(connectReq)
      await until(() => ctx.gateway.received.length >= 1)
      expect(ctx.gateway.received[0]).toBe(connectReq) // 逐字节一致

      // 网关回 connect.challenge → 浏览器逐字节收到（含中文/emoji 多字节文本）
      const challenge =
        '{"type":"event","event":"connect.challenge","payload":{"nonce":"abc-123","ts":1754200000000},"seq":1}'
      ctx.gateway.fireMessage(challenge)
      await until(() => browserReceived.length >= 1)
      expect(browserReceived[0]).toBe(challenge)

      // 后续业务帧（长中文 + emoji）：双向逐字节
      const emojiFrame =
        '{"type":"event","event":"chat","payload":{"state":"delta","deltaText":"你好 👋 世界 🌍","runId":"run-1"},"seq":2}'
      ws.send(emojiFrame)
      await until(() => ctx.gateway.received.length >= 2)
      expect(ctx.gateway.received[1]).toBe(emojiFrame)
      ctx.gateway.fireMessage(emojiFrame)
      await until(() => browserReceived.length >= 2)
      expect(browserReceived[1]).toBe(emojiFrame)

      ws.close()
    } finally {
      await ctx.close()
    }
  })

  it('浏览器断开 → 网关连接被关闭（双向清理，无泄漏）', async () => {
    const { ctx, jwt } = await makeAlphaCtx()
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      // 先发一帧确认隧道已连上网关（排除 connectGateway 未完成的竞态），再断开
      ws.send('{"type":"req","id":"p","method":"ping"}')
      await until(() => ctx.gateway.received.length >= 1)
      ws.close()
      await until(() => ctx.gateway.closed)
    } finally {
      await ctx.close()
    }
  })

  it('浏览器在网关连接建立期间断开 → 网关连接被立即关闭（防容器侧挂死连接）', async () => {
    const gateway = new FakeGateway()
    const ctx = await startTunnel({
      connectGateway: {
        connect: async () => {
          await new Promise((r) => setTimeout(r, 100)) // 延迟 resolve，模拟网关连接较慢
          return gateway
        },
      },
    })
    const user = await seedUser(ctx.prisma)
    const jwt = await signAccessToken(user.id)
    await seedContainer(ctx.prisma, user)
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      ws.close() // 网关还在连接中（100ms 延迟）即断开浏览器
      await until(() => gateway.closed)
    } finally {
      await ctx.close()
    }
  })

  it('tunnel.close() 终止全部活动隧道（优雅关闭不挂起，code review P2）', async () => {
    const { ctx, jwt } = await makeAlphaCtx()
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      const closes = collectClose(ws)
      // terminate 不等 close 握手，浏览器立即收到异常关闭（1006 或空码）
      ctx.tunnel.close()
      await until(() => closes.length > 0)
    } finally {
      await ctx.close()
    }
  })

  it('网关断开 → 浏览器隧道被关闭（透传侧 onClose 传导）', async () => {
    const { ctx, jwt } = await makeAlphaCtx()
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      const closes = collectClose(ws)
      // 先发一帧确认隧道已连上网关，再模拟网关断开
      ws.send('{"type":"req","id":"p","method":"ping"}')
      await until(() => ctx.gateway.received.length >= 1)
      ctx.gateway.fireClose(1001)
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(1001)
    } finally {
      await ctx.close()
    }
  })

  it('网关异常断开（close code 1006 保留码）→ 浏览器收到 4402 而非 1006（sanitize：保留码不可进 close frame）', async () => {
    const { ctx, jwt } = await makeAlphaCtx()
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      const closes = collectClose(ws)
      ws.send('{"type":"req","id":"p","method":"ping"}')
      await until(() => ctx.gateway.received.length >= 1)
      // 网关进程死/TCP reset → Node ws 客户端报 1006（RFC 6455 保留码）。
      // 直接 ws.close(1006) 会同步抛 TypeError（sender.validateStatusCode）——sanitize 到 4402。
      ctx.gateway.fireClose(1006)
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(4402)
    } finally {
      await ctx.close()
    }
  })

  it('单帧超 maxPayload → close(1009)（message too big：未认证客户端不能以 100MiB 级帧打满内存）', async () => {
    const { ctx, jwt } = await makeAlphaCtx()
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      const closes = collectClose(ws)
      // 先发一帧确认隧道已连上网关（否则大帧走 pending 缓冲 256KB 预算 → 1008，非本次断言目标）
      ws.send('{"type":"req","id":"p","method":"ping"}')
      await until(() => ctx.gateway.received.length >= 1)
      // 2 MiB 单帧 > maxPayload（默认 100MiB 无上限；修复后 1MiB）→ ws 接收层拒绝 close(1009)
      ws.send('x'.repeat(2 * 1024 * 1024))
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(1009)
    } finally {
      await ctx.close()
    }
  })

  it('客户端超限帧 error 被监听兜底 → 无 uncaught 崩溃（error listener 回归，codex P1）', async () => {
    // codex PR #367 意见 1：maxPayload 超限时 ws 接收层 emit WS_ERR_UNSUPPORTED_MESSAGE_LENGTH，
    // 无 error listener 则该 error 成为 uncaught——Node 默认终止整个控制面进程。本测试用
    // process 级 spy 断言 error 被 tunnel 的 `ws.on('error')` 兜底（vitest 自身 handler 会把
    // uncaught 降级为 error 而非 test failure，故须显式 spy 才能 red-capable）。
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown): void => {
      uncaught.push(e)
    }
    process.on('uncaughtException', onUncaught)
    let ctx: TunnelCtx | null = null
    try {
      const made = await makeAlphaCtx()
      ctx = made.ctx
      const { baseUrl, gateway } = made.ctx // const 解构：闭包里用不可变引用，避免 TS possibly-null
      const ws = await connectTunnel(`${baseUrl}?container=alpha`, ['access_token', made.jwt])
      const closes = collectClose(ws)
      // 先发一帧确认隧道已连上网关（否则大帧走 pending 缓冲 256KB 预算 → 1008，非本次断言目标）
      ws.send('{"type":"req","id":"p","method":"ping"}')
      await until(() => gateway.received.length >= 1)
      ws.send('x'.repeat(2 * 1024 * 1024)) // 超 maxPayload → error 事件（非认证客户端在验签前即可触发）
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(1009)
      // 给 error 事件一个传播窗口，断言未被抛成 uncaught
      await new Promise((r) => setTimeout(r, 100))
      expect(uncaught).toHaveLength(0)
    } finally {
      process.removeListener('uncaughtException', onUncaught)
      if (ctx) await ctx.close()
    }
  })
})
