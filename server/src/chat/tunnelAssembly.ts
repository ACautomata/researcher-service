// 隧道装配（#385）：server.ts 生产装配接缝。createTunnelServer 依赖较多（prisma/连接工厂/host/
// scheme），main() 内联装配难以单测「origin 是否传入连接器」——提取纯函数：给定连接工厂与
// 网关寻址，返回 createTunnelServer 参数。测试可注入假 connector 断言 panelOrigin 被传入。

import type { PrismaClient } from '../generated/prisma/client'
import { createTunnelServer, type TunnelServer } from './tunnel'
import { makeWsGatewayConnector, type GatewayConnector } from './gatewayConnector'

export interface TunnelAssemblyDeps {
  prisma: PrismaClient
  // 面板对外 origin（config.fleet.panelOrigin；#385 隧道连网关的 WS Origin）
  panelOrigin: string
  // 容器网关宿主地址 / WS scheme（config.fleet.healthHost / healthScheme）
  gatewayHost: string
  gatewayScheme: string
  // 连接工厂（测试注入 fake 断言 origin 传入；生产默认 Node ws 客户端）
  connectGateway?: GatewayConnector
}

export function assembleTunnelServer(deps: TunnelAssemblyDeps): TunnelServer {
  return createTunnelServer({
    prisma: deps.prisma,
    connectGateway: deps.connectGateway ?? makeWsGatewayConnector(undefined, undefined, deps.panelOrigin),
    gatewayHost: deps.gatewayHost,
    gatewayScheme: deps.gatewayScheme,
  })
}
