// P2-4 网关终态事件重放（codex PR #367）——makeWsGatewayConnector 在网关 open 后立即断开时，
// 终态事件（close/error）须在 onClose/onError 注册后被重放。否则浏览器隧道保持 OPEN 但上游
// 已死（容器重启中），官方协议机收不到 close/error 无法重连——隧道假活。
//
// 与消息缓冲同模式（gatewayConnector 已缓冲 open→注册窗口内的首帧）：终态也须记录并在注册时重放。

import { describe, it, expect } from 'vitest'
import http, { type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { makeWsGatewayConnector } from '../src/chat/gatewayConnector'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 模拟容器网关：upgrade 握手后 delayMs 即 terminate（容器重启中——协议机对端突然死亡）
async function startGateway(delayMs: number): Promise<{ server: Server; url: string }> {
  const server = http.createServer()
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      setTimeout(() => ws.terminate(), delayMs)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return { server, url: `ws://127.0.0.1:${port}/` }
}

describe('makeWsGatewayConnector（#337 M5 · P2-4 终态事件重放）', () => {
  it('网关 open 后立即断开（容器重启中）→ 延迟注册 onClose 仍收到 close 事件（不丢终态）', async () => {
    const { server, url } = await startGateway(20)
    try {
      const connector = makeWsGatewayConnector()
      const socket = await connector.connect(url)
      // 模拟 tunnel 的 await 链：connect resolve 后（网关已死）才注册 onClose
      await sleep(100)
      const closes: Array<{ code: number; reason: string }> = []
      socket.onClose((code, reason) => closes.push({ code, reason }))
      await sleep(100)
      expect(closes.length).toBe(1) // 修复前 = 0（事件在注册前已发生，ws.on('close') 不重放）
      expect(closes[0].code).toBe(1006) // terminate 无 close frame → Node ws 报 1006
    } finally {
      server.close()
    }
  })

  it('终态只重放一次（多次注册 onClose 各触发一次，连接已终态不再叠加）', async () => {
    const { server, url } = await startGateway(20)
    try {
      const connector = makeWsGatewayConnector()
      const socket = await connector.connect(url)
      await sleep(100)
      const closes: number[] = []
      socket.onClose((code) => closes.push(code))
      socket.onClose((code) => closes.push(code))
      await sleep(100)
      expect(closes.length).toBe(2) // 两次注册各一次（重放语义与 on('close') 一致：每 listener 一次）
      expect(closes.every((c) => c === 1006)).toBe(true)
    } finally {
      server.close()
    }
  })

  it('#7 gateway→panel ws client 须带 maxPayload=1MiB：网关推超限帧 → socket 被关（否则默认 100MiB 上限绕过浏览器腿 1MiB 封顶）', async () => {
    // 容器网关被攻陷/异常时推 >1MiB 帧：gatewayConnector 的 ws client 若沿用 ws 默认 100MiB
    // maxPayload，该帧被原样透传到浏览器——浏览器腿的 1MiB 封顶（TUNNEL_MAX_PAYLOAD）被绕过。
    const gserver = http.createServer()
    const wss = new WebSocketServer({ noServer: true })
    gserver.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(Buffer.alloc(2 * 1024 * 1024)) // 2MiB > 1MiB（网关一建连即推超限帧）
      })
    })
    await new Promise<void>((r) => gserver.listen(0, '127.0.0.1', r))
    const { port } = gserver.address() as AddressInfo
    const url = `ws://127.0.0.1:${port}/`
    try {
      const connector = makeWsGatewayConnector()
      const socket = await connector.connect(url)
      const closes: Array<{ code: number; reason: string }> = []
      socket.onClose((code, reason) => closes.push({ code, reason }))
      const messages: Array<string | Buffer> = []
      socket.onMessage((m) => messages.push(m))
      await sleep(200)
      expect(messages.length).toBe(0) // 超限帧不得被接收/透传
      expect(closes.length).toBe(1) // 修复前：client 默认 maxPayload 100MiB → 帧通过、无 close → 红
    } finally {
      gserver.close()
    }
  })

  it('#4 P2：网关慢读（TCP 背压）→ 发送缓冲超预算 socket 被关 close(1008)，不无界缓冲', async () => {
    // 网关端不消费数据（慢读）→ 内核 TCP 接收窗口填满后客户端 ws.send 内部 bufferedAmount 累积。
    // 修复前 send 无守卫、缓冲无界增长（1MiB 级帧流可打满面板进程堆）；修复后超 sendBudget
    // （注入小预算触发）→ close(1008) 经 tunnel onClose 传导浏览器，协议机决策重连。
    const gserver = http.createServer()
    const wss = new WebSocketServer({ noServer: true })
    gserver.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, () => {}) // 故意不注册 data 消费——网关读得慢
    })
    await new Promise<void>((r) => gserver.listen(0, '127.0.0.1', r))
    const { port } = gserver.address() as AddressInfo
    const url = `ws://127.0.0.1:${port}/`
    try {
      const connector = makeWsGatewayConnector(5000, 128 * 1024) // 128KB 小预算便于触发
      const socket = await connector.connect(url)
      const closes: Array<{ code: number; reason: string }> = []
      socket.onClose((code, reason) => closes.push({ code, reason }))
      // 连发 64KB 帧：内核 TCP 缓冲吸收一部分后 bufferedAmount 累积，超 128KB 预算 → close(1008)。
      // 修复前：send 无守卫，200 帧全发完仍无 close → 红。同步连发（await 会让出事件循环给内核
      // 排空缓冲、削弱累积）。
      for (let i = 0; i < 200; i++) {
        if (closes.length > 0) break
        socket.send('x'.repeat(64 * 1024))
      }
      await sleep(200)
      expect(closes.length).toBe(1) // 修复前：无 close → 红
      expect(closes[0].code).toBe(1008) // 策略违反（发送缓冲超限）
    } finally {
      gserver.close()
    }
  })

  it('F13: 网关在升级前 reset → connect 快速 reject（不误报 connect timeout 等满超时）', async () => {
    // 网关在 WS 升级握手完成前 reset TCP（容器重启/端口被占后立刻拒绝）。修复前 connect 定时器
    // 只由 open/error 清除——若 close-before-open 不触发 error，会等满 timeoutMs 误报「gateway
    // connect timeout」；修复后 close 也清除定时器并 reject。
    const gserver = http.createServer()
    gserver.on('upgrade', (_req, socket) => socket.destroy()) // 不 handleUpgrade，直接 reset
    await new Promise<void>((r) => gserver.listen(0, '127.0.0.1', r))
    const { port } = gserver.address() as AddressInfo
    const url = `ws://127.0.0.1:${port}/`
    try {
      const connector = makeWsGatewayConnector(2000) // 2s 超时——若定时器未被 close 清除会等满
      const started = Date.now()
      await expect(connector.connect(url)).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(2000) // 快速失败而非等满超时
    } finally {
      gserver.close()
    }
  })

  it('F13: 网关在 connect 窗口推超限帧 → 连接被终止（缓冲有字节上限，防内存无界）', async () => {
    // 网关建连（open）即推 10 × 64KB = 640KB > TUNNEL_PENDING_BYTE_BUDGET(256KiB)，tunnel 尚未
    // 注册 onMessage → 帧进缓冲。修复前 buffered 无字节上限（内存无界增长，对端健谈网关 DoS）；
    // 修复后超限 terminate（无论 connect 是否已 resolve，已返回 socket 经 close 重放机制感知）。
    const gserver = http.createServer()
    const wss = new WebSocketServer({ noServer: true })
    gserver.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        for (let i = 0; i < 10; i++) ws.send(Buffer.alloc(64 * 1024))
      })
    })
    await new Promise<void>((r) => gserver.listen(0, '127.0.0.1', r))
    const { port } = gserver.address() as AddressInfo
    const url = `ws://127.0.0.1:${port}/`
    try {
      const connector = makeWsGatewayConnector()
      const socket = await connector.connect(url) // resolve 后帧进入缓冲窗口
      const closes: number[] = []
      socket.onClose((code) => closes.push(code))
      await sleep(300)
      expect(closes.length).toBeGreaterThan(0) // 修复前：缓冲无上限、连接保持 → 红
    } finally {
      gserver.close()
    }
  })
})
