import { createServer } from 'node:http'
import { createApp } from './app'
import { getPrisma } from './prisma'
import { bootstrap } from './auth/bootstrap'
import { config } from './config'
import { assembleFleet } from './containers/fleetAssembly'
import { makeDockerCompile } from './wiki/compile'
import { TemplateModelConfigWriter } from './models/configWriter'
import { createTunnelServer } from './chat/tunnel'
import { makeWsGatewayConnector } from './chat/gatewayConnector'
import './types'

async function main(): Promise<void> {
  const prisma = getPrisma()
  await bootstrap(prisma) // B1 惰性首启（空表生成 admin）
  // 容器编排（#334 M2）：真 DockerRuntime + BullMQ(Redis) 队列 + worker 并发默认 2。
  const fleet = assembleFleet(prisma)
  const app = createApp({
    prisma,
    orchestrator: fleet.orchestrator,
    // approve 端点 docker exec 通道（#374）：容器内 `openclaw devices approve <requestId>`。
    runtime: fleet.runtime,
    // wiki compile（#335）：docker exec `openclaw wiki compile`，5s 去抖、best-effort。
    wiki: { compile: makeDockerCompile(fleet.runtime) },
    // models config 写盘（#336）：模板 + ConfigStore 原子写 instances/<id>/config/openclaw.json（#366）。
    models: { configWriter: new TemplateModelConfigWriter(config.fleet) },
  })

  // M0 同进程单端口分流：createServer(expressApp) + server.on('upgrade') 分流。
  // M5 隧道（#337 · ADR 0006）：/ws/chat/ 由隧道接管（JWT subprotocol 握手 + 归属门 + 原始帧透传
  // 到容器网关）；其余 upgrade 请求拒绝（避免裸挂导致悬空连接）。
  const tunnel = createTunnelServer({
    prisma,
    connectGateway: makeWsGatewayConnector(),
    gatewayHost: config.fleet.healthHost,
    gatewayScheme: config.fleet.healthScheme,
  })
  const server = createServer(app)
  server.on('upgrade', (req, socket, head) => {
    if (!tunnel.handleUpgrade(req, socket, head)) socket.destroy()
  })

  // 优雅关闭：drain BullMQ worker（在飞 provisioning 完成或标 ERROR）。
  const shutdown = async (): Promise<void> => {
    await fleet.close().catch(() => {})
    // 先终止活动隧道（http.Server.close 会等升级后的 WS 连接自然断开——有浏览器持隧道时挂起）
    tunnel.close()
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] 控制面 listening on :${config.port}`)
  })
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[server] 启动失败', e)
  process.exit(1)
})
