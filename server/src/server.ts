import { createServer } from 'node:http'
import { createApp } from './app'
import { getPrisma } from './prisma'
import { bootstrap } from './auth/bootstrap'
import { config } from './config'
import { assembleFleet } from './containers/fleetAssembly'
import { makeDockerCompile } from './wiki/compile'
import { TemplateModelConfigWriter } from './models/configWriter'
import './types'

async function main(): Promise<void> {
  const prisma = getPrisma()
  await bootstrap(prisma) // B1 惰性首启（空表生成 admin）
  // 容器编排（#334 M2）：真 DockerRuntime + BullMQ(Redis) 队列 + worker 并发默认 2。
  const fleet = assembleFleet(prisma)
  const app = createApp({
    prisma,
    orchestrator: fleet.orchestrator,
    // wiki compile（#335）：docker exec `openclaw wiki compile`，5s 去抖、best-effort。
    wiki: { compile: makeDockerCompile(fleet.runtime) },
    // models config 写盘（#336）：模板 + ConfigStore 原子写 instances/<id>/openclaw.json。
    models: { configWriter: new TemplateModelConfigWriter(config.fleet) },
  })

  // M0 同进程单端口分流：createServer(expressApp) + server.on('upgrade') 分流。
  // upgrade 钩子由 M4 接 ws 桥（noServer + handleUpgrade + subprotocol 回显）；本期仅 HTTP。
  const server = createServer(app)
  server.on('upgrade', (_req, socket) => {
    // M4 前：无 WS 路由，直接拒绝升级（避免裸挂导致悬空连接）
    socket.destroy()
  })

  // 优雅关闭：drain BullMQ worker（在飞 provisioning 完成或标 ERROR）。
  const shutdown = async (): Promise<void> => {
    await fleet.close().catch(() => {})
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
