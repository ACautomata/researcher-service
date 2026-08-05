// #385 生产 Origin 接线（装配接缝）：server.ts 经 assembleTunnelServer 装配隧道，面板 origin
// （config.fleet.panelOrigin）须传入 makeWsGatewayConnector 作为 WS Origin——真网关 2026.7.1
// 校验 Origin 须在容器 allowedOrigins 内（PR #384 实测），否则隧道连网关被
// CONTROL_UI_ORIGIN_NOT_ALLOWED 拒。server.ts 的 main() 依赖真实 prisma/redis，直接测装配函数
// 才是可测接缝：mock makeWsGatewayConnector 捕获调用参数，断言 origin 正确透传。

import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '../src/generated/prisma/client'
import { assembleTunnelServer } from '../src/chat/tunnelAssembly'

// vi.hoisted：工厂函数引用外部变量须经 hoisted 桶（vi.mock 提升到 import 之前执行）。
const connectorMock = vi.hoisted(() => ({
  makeWsGatewayConnector: vi.fn(() => ({
    connect: async () => {
      throw new Error('not used in assembly test')
    },
  })),
}))

vi.mock('../src/chat/gatewayConnector', () => ({
  makeWsGatewayConnector: connectorMock.makeWsGatewayConnector,
}))

// createTunnelServer 构造期只用 deps 建 WebSocketServer，不查库——假 prisma 足够。
const fakePrisma = {} as unknown as PrismaClient

describe('assembleTunnelServer origin 接线（#385）', () => {
  it('生产装配：默认连接工厂收到面板 origin（makeWsGatewayConnector 第三参）', () => {
    connectorMock.makeWsGatewayConnector.mockClear()
    const tunnel = assembleTunnelServer({
      prisma: fakePrisma,
      panelOrigin: 'https://panel.example.com',
      gatewayHost: '127.0.0.1',
      gatewayScheme: 'ws',
    })
    expect(connectorMock.makeWsGatewayConnector).toHaveBeenCalledWith(
      undefined,
      undefined,
      'https://panel.example.com',
    )
    // host/scheme 一并透传 createTunnelServer
    tunnel.close()
  })

  it('注入自定义连接工厂 → 覆盖默认（测试注入点保留，不传 origin 工厂）', () => {
    connectorMock.makeWsGatewayConnector.mockClear()
    const injected = { connect: async () => ({ send: () => {}, close: () => {}, onMessage: () => {}, onClose: () => {}, onError: () => {} }) }
    const tunnel = assembleTunnelServer({
      prisma: fakePrisma,
      panelOrigin: 'https://panel.example.com',
      gatewayHost: '127.0.0.1',
      gatewayScheme: 'ws',
      connectGateway: injected,
    })
    // 注入连接工厂时不再调用默认工厂（测试注入点语义）
    expect(connectorMock.makeWsGatewayConnector).not.toHaveBeenCalled()
    tunnel.close()
  })
})
