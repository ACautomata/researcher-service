// #337 M5 对话桥接核心（ADR 0006 隧道形态）——测试接缝 3 WS 桥。
// 真实 http server + 真实 ws 客户端（Node ws 库）拨 upgrade，注入 fake 容器网关：
//   - 握手：两格式 subprotocol 原样回显、authenticate() 同源验签、归属门（越权/不存在 4401）
//   - 拒绝：无效/过期 token → accept-then-close(4401)；网关不可达 → 4402
//   - 透传：浏览器↔网关原始帧字节级原样（零解析/零翻译的强证据：长文本/emoji 逐字节一致）
//
// 协议 v4 握手/重连/会话投影由官方包（浏览器侧）负责，本测试不测协议机，只测隧道承载字节。
// 每用例独立 ctx（真实 http server + 临时 SQLite + fake 网关），try/finally 清理——不共享
// 模块级 ctx（「容器网关不可达」曾替换共享 ctx 污染后续用例，改为自建更稳）。

import { describe, it, expect, vi } from 'vitest'
import http, { type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { SignJWT } from 'jose'
import { createSecretKey, randomBytes } from 'node:crypto'
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
  received: Array<string | Buffer> = [] // 后端→网关（= 浏览器发出的原帧）
  closed = false // 网关侧 close 被调用（浏览器断开 → 后端清理）
  closedCode: number | null = null
  closedReason = ''
  private msgCb: ((data: string | Buffer) => void) | null = null
  private closeCb: ((code: number, reason: string) => void) | null = null
  send(data: string | Buffer): void {
    this.received.push(data)
  }
  close(code?: number, reason?: string): void {
    this.closed = true
    this.closedCode = code ?? null
    this.closedReason = reason ?? ''
  }
  onMessage(cb: (data: string | Buffer) => void): void {
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

function fakeConnector(gateway: FakeGateway, fail = false, recordedUrls: string[] = []): GatewayConnector {
  return {
    connect: async (url) => {
      if (fail) throw new Error('ECONNREFUSED 127.0.0.1')
      recordedUrls.push(url)
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
async function startTunnel(
  opts: {
    failGateway?: boolean
    connectGateway?: GatewayConnector
    gatewayScheme?: string
    revalidateMs?: number
    maxConnections?: number
  } = {},
): Promise<TunnelCtx> {
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
    gatewayScheme: opts.gatewayScheme ?? 'ws',
    revalidateMs: opts.revalidateMs,
    maxConnections: opts.maxConnections,
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
      tunnel.close() // 终止隧道 + 清复查 interval（F6 竞态测试/防 interval handle 泄漏）
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await prisma.$disconnect()
    },
  }
}

async function seedContainer(
  prisma: PrismaClient,
  owner: User,
  name = 'alpha',
  port = 19001,
  status: 'running' | 'creating' | 'stopped' | 'removing' | 'error' = 'running',
): Promise<void> {
  await prisma.container.create({
    data: {
      name,
      port,
      ownerId: owner.id,
      token: 'enc', // 隧道不读 token（不注入凭证）；bootstrap token 发放属 #338
      tokenEncrypted: false,
      homeDir: '/tmp/alpha-home',
      status,
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

// ws 客户端 helper：连隧道并等 open；失败/未 open 即断开 reject（F6 竞态场景 close-before-open）。
function connectTunnel(url: string, protocols?: string | string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = protocols === undefined ? new WebSocket(url) : new WebSocket(url, protocols)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
    ws.once('close', () => reject(new Error('connection closed before open')))
  })
}

// --- raw socket WS 客户端（#1/#5：模拟恶意客户端——收到 close frame 不回 ack、可发任意帧）---
// Node ws client 在 CLOSING 态 send 不发送，无法模拟「被拒 socket 上仍发超限帧」的攻击；raw socket
// 手动完成 upgrade 后不回 close ack，让 server 侧 socket 停在 CLOSING 窗口，期间注入超限帧。
async function rawUpgrade(url: string, protocols: string[]): Promise<net.Socket> {
  const u = new URL(url)
  const sock = net.connect(Number(u.port), u.hostname)
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', resolve)
    sock.once('error', reject)
  })
  // ws 校验 Sec-WebSocket-Key 须 base64 解码后恰 16 字节，否则 400（握手到不了 accept 路径）
  const key = randomBytes(16).toString('base64')
  sock.write(
    `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
      `Host: ${u.hostname}:${u.port}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n' +
      `Sec-WebSocket-Protocol: ${protocols.join(', ')}\r\n\r\n`,
  )
  await new Promise<void>((resolve, reject) => {
    let buf = ''
    const onData = (d: Buffer): void => {
      buf += d.toString('latin1')
      if (buf.includes('\r\n\r\n')) {
        sock.removeListener('data', onData)
        resolve()
      }
    }
    sock.on('data', onData)
    sock.once('error', reject)
  })
  return sock
}

// 构造一个 >1MiB 的 masked 二进制帧（超 TUNNEL_MAX_PAYLOAD，触发 receiver WS_ERR_UNSUPPORTED_MESSAGE_LENGTH）
function oversizedFrame(size = 2 * 1024 * 1024): Buffer {
  const payload = Buffer.alloc(size, 0x41)
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
  const frame = Buffer.alloc(2 + 8 + 4 + payload.length)
  frame[0] = 0x82 // FIN + binary
  frame[1] = 0x80 | 127 // masked + 64-bit length
  frame.writeBigUInt64BE(BigInt(payload.length), 2)
  mask.copy(frame, 10)
  for (let i = 0; i < payload.length; i++) frame[14 + i] = payload[i] ^ mask[i % 4]
  return frame
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

  it('越权（他人容器）→ close(4404)；不存在容器 → close(4404)（同码防探测，#3：非认证码，前端不 forceRefresh）', async () => {
    const { ctx, jwt } = await makeAlphaCtx()
    try {
      const other = await seedUser(ctx.prisma, 'user2')
      await seedContainer(ctx.prisma, other, 'beta', 19002)
      const otherJwt = await signAccessToken(other.id)

      // 越权：user2 连 user 的 alpha 容器
      const ws1 = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', otherJwt])
      const closes1 = collectClose(ws1)
      await until(() => closes1.length > 0)
      expect(closes1[0].code).toBe(4404)

      // 不存在：合法 token 连 ghost 容器
      const ws2 = await connectTunnel(`${ctx.baseUrl}?container=ghost`, ['access_token', jwt])
      const closes2 = collectClose(ws2)
      await until(() => closes2.length > 0)
      expect(closes2[0].code).toBe(4404)
    } finally {
      await ctx.close()
    }
  })

  it('容器名缺失 → close(4404)（#3：容器维度问题，非凭证过期，与 4401 认证码分离）', async () => {
    const { ctx, jwt } = await makeAlphaCtx()
    try {
      const ws = await connectTunnel(ctx.baseUrl, ['access_token', jwt])
      const closes = collectClose(ws)
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(4404)
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

  it('#12 容器非 running 状态（creating/stopped/removing/error）→ close(4402)，不连网关', async () => {
    const ctx = await startTunnel()
    const user = await seedUser(ctx.prisma)
    const jwt = await signAccessToken(user.id)
    // creating：端口已预留但 in-container 网关未起——连了也 ECONNREFUSED/accept 无 upgrade 卡 5s 超时；
    // error/removing 容器宿主端口可能被无关进程占用 → 原始帧转发到错误目标。故连网关前校验就绪。
    await seedContainer(ctx.prisma, user, 'alpha', 19001, 'creating')
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      const closes = collectClose(ws)
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(4402) // 修复前：不查 status 直接连网关（fake connector 成功）→ 隧道建立无 close → 红
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

  it('#9 二进制帧原样 Buffer 透传（不 toString 有损 UTF-8，字节管道契约）', async () => {
    const { ctx, jwt } = await makeAlphaCtx()
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      ws.send('{"type":"req","id":"p","method":"ping"}') // 确认连上网关
      await until(() => ctx.gateway.received.length >= 1)
      // 非 UTF-8 字节序列：修复前 data.toString() 把 0xff/0x80 有损为 U+FFFD mojibake 并以文本帧重发
      const bin = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x00, 0x01])
      ws.send(bin) // Node ws client send(Buffer) → 二进制帧（opcode 2）
      await until(() => ctx.gateway.received.length >= 2)
      const got = ctx.gateway.received[1]
      expect(Buffer.isBuffer(got)).toBe(true) // 修复前：toString 后是 string → 红
      expect((got as Buffer).equals(bin)).toBe(true) // 逐字节无损
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

  it('authenticate 遇 DB 故障（非认证失败）→ close(1011) 而非 4401（F1：DB 瞬断不触发 forceRefresh 风暴）', async () => {
    const { ctx, jwt } = await makeAlphaCtx()
    try {
      // 模拟 DB 连接池耗尽：findUnique 抛普通 Error（非 AuthenticationError）→ 内部故障码
      vi.spyOn(ctx.prisma.user, 'findUnique').mockRejectedValueOnce(new Error('SQLITE BUSY'))
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      const closes = collectClose(ws)
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(1011)
    } finally {
      await ctx.close()
    }
  })

  it('网关 URL 用配置 scheme（F2：OPENCLAW_FLEET_WS_SCHEME=wss 生效，不硬编码 ws）', async () => {
    const recorded: string[] = []
    const gateway = new FakeGateway()
    const ctx = await startTunnel({ gatewayScheme: 'wss', connectGateway: fakeConnector(gateway, false, recorded) })
    const user = await seedUser(ctx.prisma)
    const jwt = await signAccessToken(user.id)
    await seedContainer(ctx.prisma, user)
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      await until(() => recorded.length >= 1)
      expect(recorded[0]).toBe('wss://127.0.0.1:19001/')
      ws.close()
    } finally {
      await ctx.close()
    }
  })

  it('活动隧道周期复查：user 被禁用后隧道 close(4401)（F4：管理员禁用不被长连接绕过）', async () => {
    const ctx = await startTunnel({ revalidateMs: 50 })
    const user = await seedUser(ctx.prisma)
    const jwt = await signAccessToken(user.id)
    await seedContainer(ctx.prisma, user)
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      // 先发一帧确认隧道已连上网关（排除建连未完成竞态）
      ws.send('{"type":"req","id":"p","method":"ping"}')
      await until(() => ctx.gateway.received.length >= 1)
      const closes = collectClose(ws)
      // 管理员禁用用户 → 下轮复查（50ms interval）→ 隧道被关
      await ctx.prisma.user.update({ where: { id: user.id }, data: { isActive: false } })
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(4401)
    } finally {
      await ctx.close()
    }
  })

  it('#6 周期复查区分失效码：mustChangePassword 用户隧道 close(4403)（对齐握手门，非 4401 不 forceRefresh）', async () => {
    const ctx = await startTunnel({ revalidateMs: 50 })
    const user = await seedUser(ctx.prisma, 'must-reval')
    const jwt = await signAccessToken(user.id)
    await seedContainer(ctx.prisma, user)
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      ws.send('{"type":"req","id":"p","method":"ping"}')
      await until(() => ctx.gateway.received.length >= 1)
      const closes = collectClose(ws)
      // 管理员设改密 → 下轮复查 → 隧道被关。与握手门同源（4403）：token 有效但授权未就绪。
      // 修复前复用 4401 → 前端误判 token 过期 forceRefresh 风暴。
      await ctx.prisma.user.update({ where: { id: user.id }, data: { mustChangePassword: true } })
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(4403)
    } finally {
      await ctx.close()
    }
  })

  it('#10 复查 interval 惰性启停：createTunnelServer 不创建定时器、首个认证隧道启动、最后一个关闭清除', async () => {
    // findMany 在 0 隧道时被 revalidateTunnelUsers 的 byUser.size===0 早退跳过，测不出 interval 是否
    // 空转；须 spy setInterval/clearInterval 直测「定时器是否被创建/清除」这一机制差异。
    const setSpy = vi.spyOn(globalThis, 'setInterval')
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const ctx = await startTunnel({ revalidateMs: 50 })
    const user = await seedUser(ctx.prisma)
    const jwt = await signAccessToken(user.id)
    await seedContainer(ctx.prisma, user)
    try {
      // 1. 无隧道：createTunnelServer 不得创建复查定时器（修复前 boot 即 setInterval → 红）
      expect(setSpy).not.toHaveBeenCalled()
      // 2. 建隧道 → 认证成功 → interval 惰性启动
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      ws.send('{"type":"req","id":"p","method":"ping"}')
      await until(() => ctx.gateway.received.length >= 1)
      await until(() => setSpy.mock.calls.length > 0)
      // 3. 全关 → interval 清除（不常驻空转）
      ws.close()
      await until(() => ws.readyState === WebSocket.CLOSED)
      await new Promise((r) => setTimeout(r, 50)) // 等 close 事件传播到 stopRevalidate
      expect(clearSpy.mock.calls.length).toBeGreaterThan(0)
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
      await ctx.close()
    }
  })

  it('网关自身 close 4401（容器侧 auth 失败）→ 浏览器收到 4402 而非 4401（F5：不与面板认证码混淆）', async () => {
    const { ctx, jwt } = await makeAlphaCtx()
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      const closes = collectClose(ws)
      ws.send('{"type":"req","id":"p","method":"ping"}')
      await until(() => ctx.gateway.received.length >= 1)
      ctx.gateway.fireClose(4401)
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(4402) // 网关 4401 → 面板 4402（网关不可达语义，前端不 forceRefresh）
    } finally {
      await ctx.close()
    }
  })

  it('tunnel.close() 后新 upgrade 立即 terminate（F6：并发 upgrade 竞态不挂起 server.close）', async () => {
    const { ctx, jwt } = await makeAlphaCtx()
    try {
      ctx.tunnel.close()
      // closing 标志 → 新 upgrade 不被留下挂起：terminate 可能在客户端收到 101 前（close-before-open
      // reject）或后（open 后立即 close）。两种都证明「close 后连接不存活」，否则 until 超时红。
      let closed = false
      try {
        const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
        ws.on('close', () => {
          closed = true
        })
      } catch {
        closed = true // close-before-open：被 terminate（connectTunnel 的 close→reject）
      }
      await until(() => closed)
    } finally {
      await ctx.close()
    }
  })

  it('并发隧道连接数超上限 → 新连接 close(1008)（F8：resource-exhaustion 第二维）', async () => {
    const ctx = await startTunnel({ maxConnections: 2 })
    const user = await seedUser(ctx.prisma)
    const jwt = await signAccessToken(user.id)
    await seedContainer(ctx.prisma, user)
    try {
      const ws1 = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      const ws2 = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      // 第 3 个连接超上限（accept 后计数 3 > 2）→ 策略违反 close(1008)
      const ws3 = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      const closes = collectClose(ws3)
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(1008)
      ws1.close()
      ws2.close()
    } finally {
      await ctx.close()
    }
  })

  it('#1 P0：maxConnections 拒绝路径的超限帧被 error 兜底，不 uncaught 崩溃（被拒 socket 也须有 error listener）', async () => {
    // 拒绝路径（activeConnections > cap）在进 handleConnection 前 return，其内部才注册的
    // ws.on('error') 不覆盖被拒 socket——攻击者对被拒 socket 发超限帧 → receiver emit
    // WS_ERR_UNSUPPORTED_MESSAGE_LENGTH → 无 listener 的 EventEmitter 抛 uncaughtException 杀进程。
    // raw socket 不回 close ack，让被拒连接停在 CLOSING 窗口（Node ws client 会回 ack 触发不到）。
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown): void => {
      uncaught.push(e)
    }
    process.on('uncaughtException', onUncaught)
    const ctx = await startTunnel({ maxConnections: 1 })
    const user = await seedUser(ctx.prisma)
    const jwt = await signAccessToken(user.id)
    await seedContainer(ctx.prisma, user)
    try {
      const ws1 = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt]) // 占用名额
      const raw = await rawUpgrade(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt]) // 被拒
      await new Promise((r) => setTimeout(r, 100)) // 等 server 完成拒绝（close(1008) 已发出）
      raw.write(oversizedFrame()) // 被拒 socket 上发超限帧 → 触发 receiver error
      await new Promise((r) => setTimeout(r, 300))
      expect(uncaught).toHaveLength(0) // 修复前：无 error listener → uncaught（vitest 降级为 spy 捕获）
      raw.destroy()
      ws1.close()
    } finally {
      process.removeListener('uncaughtException', onUncaught)
      await ctx.close()
    }
  })

  it('#5 maxConnections 名额在拒绝时立即释放：被拒连接不回 close ack 不占 30s 名额（CLOSING 僵尸反噬 cap）', async () => {
    // 修复前 activeConnections-- 只在 ws 'close' 事件（对端回 close ack 后）触发；被拒连接若忽略
    // close frame，socket 停在 CLOSING 30s（ws closeTimeout）仍占名额 → cap 变成自我可用性损失。
    const ctx = await startTunnel({ maxConnections: 1 })
    const user = await seedUser(ctx.prisma)
    const jwt = await signAccessToken(user.id)
    await seedContainer(ctx.prisma, user)
    try {
      const ws1 = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt]) // 占名额
      const raw = await rawUpgrade(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt]) // 被拒、挂起不回 ack
      await new Promise((r) => setTimeout(r, 100)) // 等 server 完成拒绝
      ws1.close()
      await until(() => ws1.readyState === WebSocket.CLOSED) // 等 ws1 close 握手完成（server 端 close 事件已处理）
      // 新连接应能连上（raw 的名额已随拒绝释放）
      let ws3: WebSocket | null = null
      try {
        ws3 = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      } catch {
        // 修复前：raw 还占名额 → ws3 超限被拒 → connectTunnel reject
      }
      expect(ws3).not.toBeNull()
      expect(ws3!.readyState).toBe(WebSocket.OPEN)
      ws3!.close()
      raw.destroy()
    } finally {
      await ctx.close()
    }
  })

  it('#1 P1：认证拒绝路径也须立即释放名额——未认证坏 token 不回 close ack 不得占 30s 名额（隧道 DoS）', async () => {
    // 第二轮 #5 只修了 maxConnections 拒绝分支。认证（4401）/归属（4404）/改密门（4403）/网关（4402）
    // 等拒绝路径仍只 ws.close() 后 return——被拒连接忽略 close frame 时 socket 停在 CLOSING 30s
    // （ws closeTimeout 等对端 ack），名额仍被占满 TUNNEL_MAX_CONNECTIONS，期间所有合法新隧道被
    // close(1008)；30s 后循环重放 = 持续未认证隧道 DoS。releaseSlot 须覆盖 handleConnection 全部
    // 拒绝路径（不只 maxConnections 分支）。
    const ctx = await startTunnel({ maxConnections: 1 })
    const user = await seedUser(ctx.prisma)
    const jwt = await signAccessToken(user.id)
    await seedContainer(ctx.prisma, user)
    try {
      // 未认证攻击者：raw socket 发坏 token → accept 后 close(4401)，不回 close ack（停 CLOSING 占名额）
      const raw = await rawUpgrade(`${ctx.baseUrl}?container=alpha`, ['access_token', 'bad-token'])
      await new Promise((r) => setTimeout(r, 100)) // 等 server 完成 4401 拒绝
      // 合法用户应能连上：raw 的名额随 4401 拒绝立即释放（修复前被占 → 新连接超限 close(1008)）
      let ws: WebSocket | null = null
      try {
        ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      } catch {
        // 修复前：raw 占名额 → 新连接超限被拒 → connectTunnel reject
      }
      expect(ws).not.toBeNull()
      expect(ws!.readyState).toBe(WebSocket.OPEN)
      ws!.close()
      raw.destroy()
    } finally {
      await ctx.close()
    }
  })

  it('#2 P2：handleConnection 异步 reject 不得 unhandledRejection 杀进程（fire-and-forget 须 .catch 兜底）', async () => {
    // `void handleConnection(...)` 返回值被丢弃且无 .catch——async 体内未包裹同步段任一 throw
    // （flush 循环 gateway.send 等）即 Promise reject；Node≥15 默认 --unhandled-rejections=throw
    // → fatal 杀进程。注入：延迟 connect 让浏览器帧进 pending，connect 后 flush 循环 gateway.send
    // 抛错 → async reject。修复前无 .catch → unhandledRejection（vitest 降级为 spy 捕获）→ 红。
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e)
    }
    process.on('unhandledRejection', onUnhandled)
    const gateway = new FakeGateway()
    gateway.send = () => {
      throw new Error('send boom')
    }
    const ctx = await startTunnel({
      connectGateway: {
        connect: async () => {
          await new Promise((r) => setTimeout(r, 100)) // 拉长 pending 窗口，让浏览器帧先进 pending
          return gateway
        },
      },
    })
    const user = await seedUser(ctx.prisma)
    const jwt = await signAccessToken(user.id)
    await seedContainer(ctx.prisma, user)
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      ws.send('{"type":"req","id":"p","method":"ping"}') // pending → flush 时 gateway.send 抛错 → reject
      await new Promise((r) => setTimeout(r, 300))
      expect(unhandled).toHaveLength(0) // 修复前：unhandledRejection → 红
      ws.close()
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
      await ctx.close()
    }
  })

  it('#11 handleUpgrade 同步异常不逃逸杀进程（try/catch + destroy socket 兜底）', async () => {
    // ws 8.21 在「同一 socket 二次 handleUpgrade」等路径同步 throw（websocket-server.js completeUpgrade）；
    // 裸调会把 throw 从 server.on('upgrade') listener 逃逸成 uncaughtException 杀进程。当前路径不触发，
    // 属加固项——mock throw 验证 tunnel 侧 try/catch 兜底。
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown): void => {
      uncaught.push(e)
    }
    process.on('uncaughtException', onUncaught)
    const ctx = await startTunnel()
    const user = await seedUser(ctx.prisma)
    const jwt = await signAccessToken(user.id)
    await seedContainer(ctx.prisma, user)
    try {
      const spy = vi
        .spyOn(WebSocketServer.prototype, 'handleUpgrade')
        .mockImplementationOnce(() => {
          throw new Error('server.handleUpgrade() was called more than once with the same socket')
        })
      // 触发 upgrade（忽略结果：修复后 socket 被 destroy → 连接失败 reject；修复前 throw 逃逸 uncaught）
      connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt]).catch(() => {})
      await new Promise((r) => setTimeout(r, 500))
      expect(uncaught).toHaveLength(0) // 修复前：throw 逃逸 → uncaught → 红
      spy.mockRestore()
    } finally {
      process.removeListener('uncaughtException', onUncaught)
      await ctx.close()
    }
  })

  it('#3 P3：非精确路径段不按隧道处理——/ws/chat/foo 握手失败而非 4404（WS_CHAT_PATH 前缀界定收窄）', async () => {
    const { ctx, jwt } = await makeAlphaCtx()
    try {
      // 修复前：startsWith('/ws/chat/') 命中 /ws/chat/foo → 按隧道处理 → query 无 container → 先
      // accept 后 close(4404)，connectTunnel resolve。修复后：pathname !== '/ws/chat/' →
      // handleUpgrade 返回 false → server 侧 destroy → 握手失败（close-before-open）→ reject。
      let resolved = false
      try {
        const ws = await connectTunnel(`${ctx.baseUrl}foo?container=alpha`, ['access_token', jwt])
        resolved = true
        ws.close()
      } catch {
        resolved = false
      }
      expect(resolved).toBe(false) // 修复前：resolved=true（4404 先 accept 后 close）→ 红
    } finally {
      await ctx.close()
    }
  })

  // ===== diagnosing-bugs 新增：/code-review 报告 3 个 bug 的回归测试 =====

  it('REGRESSION-B 周期复查关闭隧道也须立即释放名额：被禁用用户不回 close ack 不得占 30s 名额（F4 关闭路径的 slot 释放缺口）', async () => {
    // #5/#1 P1 已覆盖握手拒绝路径的 slot 释放；revalidateTunnelUsers 的 close(4401) 是第 10 条
    // 关闭路径且只靠 close 事件释放。被禁用用户若忽略 close frame（socket 停 CLOSING 30s），
    // 名额被占满 cap → 面板级新隧道全被拒。测试：cap=1 + raw 隧道被 revalidate 关闭（不回 ack）
    // → 另一 active 用户的新连接应能连上（修复前 slot 被占 → close(1008) reject）。
    // 注：新连接不能用被禁用 user 的 jwt——authenticate 同源校验 isActive 也会拒（4401），
    // 故用独立 user2 连其自己的容器 beta。
    const ctx = await startTunnel({ maxConnections: 1, revalidateMs: 50 })
    const user1 = await seedUser(ctx.prisma, 'reval-user1')
    const user2 = await seedUser(ctx.prisma, 'reval-user2')
    const jwt1 = await signAccessToken(user1.id)
    const jwt2 = await signAccessToken(user2.id)
    await seedContainer(ctx.prisma, user1, 'alpha', 19001)
    await seedContainer(ctx.prisma, user2, 'beta', 19002)
    try {
      // raw socket 用 user1 建隧道（合法认证、占名额），之后不回 close ack
      const raw = await rawUpgrade(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt1])
      await new Promise((r) => setTimeout(r, 200)) // 等 authenticate+建连+revalidate interval 建立
      // 管理员禁用 user1 → 下轮复查 close(4401) raw；raw 不回 ack → CLOSING（修复前 slot 仍被占）
      await ctx.prisma.user.update({ where: { id: user1.id }, data: { isActive: false } })
      await new Promise((r) => setTimeout(r, 100)) // 等 revalidate 执行
      // user2 连自己的 beta 容器应能连上：raw 的名额已随 revalidate 关闭立即释放
      let ws: WebSocket | null = null
      try {
        ws = await connectTunnel(`${ctx.baseUrl}?container=beta`, ['access_token', jwt2])
      } catch {
        // 修复前：raw 占名额 → 新连接超限被拒 → connectTunnel reject
      }
      expect(ws).not.toBeNull()
      expect(ws!.readyState).toBe(WebSocket.OPEN)
      ws!.close()
      raw.destroy()
    } finally {
      await ctx.close()
    }
  })

  it('REGRESSION-C 竞态：浏览器在 authenticate await 期间断开 → 不得对已关闭连接启动复查 interval（空转 interval 泄漏）', async () => {
    // 修复前：close 事件先触发（stopRevalidate no-op，timer 尚 null）→ authenticate resolve 后
    // startRevalidate() 对已关闭 ws 启动 interval；该 ws 的 close 事件已过，再无 close 事件去
    // stopRevalidate → 常驻 30s 空转 interval（#10「最后一个关闭清除」不变量被破坏）。
    const setSpy = vi.spyOn(globalThis, 'setInterval')
    const ctx = await startTunnel({ revalidateMs: 50 })
    const user = await seedUser(ctx.prisma)
    const jwt = await signAccessToken(user.id)
    await seedContainer(ctx.prisma, user)
    try {
      // 拉长 authenticate（findUnique 延迟 200ms）：open 后立即 close → close 事件在 authenticate
      // resolve 前触发（确定性时序；loopback close 传播 ~1ms << 200ms）
      const orig = ctx.prisma.user.findUnique.bind(ctx.prisma.user)
      vi.spyOn(ctx.prisma.user, 'findUnique').mockImplementation(
        (async (args: unknown) => {
          await new Promise((r) => setTimeout(r, 200))
          return orig(args as never)
        }) as never,
      )
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      ws.close() // open 后立即断开（authenticate 仍在 200ms 延迟中）
      await new Promise((r) => setTimeout(r, 500)) // 等 authenticate resolve + 修复前 startRevalidate 执行
      // 修复前：interval 已启动（setSpy.calls=1）→ 红；修复后：断开路径不启动（calls=0）
      expect(setSpy.mock.calls.length).toBe(0)
    } finally {
      setSpy.mockRestore()
      await ctx.close()
    }
  })

  it('REGRESSION-A 网关→浏览器转发腿背压守卫：浏览器慢读时面板不无界缓冲（close(1008) 防面板内存 DoS）', async () => {
    // #4 P2 的 TUNNEL_SEND_BUDGET 只守 gatewayConnector.send（browser→gateway 方向）；gateway→browser
    // 转发腿（gateway.onMessage → ws.send）无 bufferedAmount 检查。浏览器慢读（后台标签页 TCP 窗口
    // 关闭）时面板侧 ws.send 缓冲无界增长 → 面板堆耗尽。模拟：暂停客户端 TCP 读取 → 网关推超预算
    // 帧 → 面板 bufferedAmount 累积 → 修复后 close(1008)；恢复读取让 close frame 到达客户端。
    const { ctx, jwt } = await makeAlphaCtx()
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      const closes = collectClose(ws)
      ws.send('{"type":"req","id":"p","method":"ping"}')
      await until(() => ctx.gateway.received.length >= 1)
      // 模拟浏览器慢读：暂停 TCP 读取 → 面板 send 受阻 → 面板侧 ws.bufferedAmount 累积
      const sock = (ws as unknown as { _socket: net.Socket })._socket
      sock.pause()
      // 网关推超预算帧（32×1MiB > 4MiB send budget；同步连发不让出事件循环给内核排空）
      for (let i = 0; i < 32; i++) {
        if (closes.length > 0) break
        ctx.gateway.fireMessage('x'.repeat(1024 * 1024))
      }
      // 恢复读取：面板 close(1008) 的 close frame 已排队 → resume 后到达客户端 → close 事件
      sock.resume()
      await until(() => closes.length > 0)
      expect(closes[0].code).toBe(1008) // 修复前：无守卫，32 帧全发、无 close → 红
    } finally {
      await ctx.close()
    }
  })

  it('records a text trace log for a completed chat run', async () => {
    const { ctx, jwt, user } = await makeAlphaCtx()
    try {
      const ws = await connectTunnel(`${ctx.baseUrl}?container=alpha`, ['access_token', jwt])
      const browserReceived = collectMessages(ws)

      ws.send(
        JSON.stringify({
          type: 'req',
          id: 'send-1',
          method: 'chat.send',
          params: { sessionKey: 'sk-1', message: '学习的技术' },
        }),
      )
      await until(() => ctx.gateway.received.length >= 1)
      ctx.gateway.fireMessage(JSON.stringify({ type: 'res', id: 'send-1', ok: true, payload: { runId: 'run-1' } }))
      ctx.gateway.fireMessage(
        JSON.stringify({
          type: 'event',
          event: 'chat',
          payload: { runId: 'run-1', sessionKey: 'sk-1', state: 'final', message: '学习技术的笔记' },
        }),
      )

      for (let i = 0; i < 200 && (await ctx.prisma.textTraceLog.count()) === 0; i++) {
        await new Promise((r) => setTimeout(r, 5))
      }
      expect(await ctx.prisma.textTraceLog.count()).toBe(1)
      expect(browserReceived).toHaveLength(2)
      const log = await ctx.prisma.textTraceLog.findFirstOrThrow()
      expect(log).toMatchObject({
        userId: user.id,
        username: user.username,
        ipAddress: '127.0.0.1',
        containerName: 'alpha',
        sessionKey: 'sk-1',
        runId: 'run-1',
        inputText: '学习的技术',
        outputText: '学习技术的笔记',
        status: 'success',
      })
      expect(log.traceId).toMatch(/^[a-f0-9]{64}$/)
      expect(log.outputHash).toMatch(/^[a-f0-9]{64}$/)
      ws.close()
    } finally {
      await ctx.close()
    }
  })
})
