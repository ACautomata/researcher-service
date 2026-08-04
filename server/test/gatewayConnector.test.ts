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
})
