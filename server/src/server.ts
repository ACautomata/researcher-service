import { createServer } from 'node:http'
import { createApp } from './app'
import { getPrisma } from './prisma'
import { bootstrap } from './auth/bootstrap'
import { config } from './config'
import { Orchestrator } from './orchestrator/orchestrator'
import { DockerRuntime } from './orchestrator/dockerRuntime'
import { createTokenCrypto } from './orchestrator/tokenCrypto'
import { BullMqProvisionQueue, createProvisioningWorker } from './provisioning/queue'
import './types'

async function main(): Promise<void> {
  const prisma = getPrisma()
  await bootstrap(prisma) // B1 惰性首启（空表生成 admin）

  // M2：编排器 + BullMQ 队列 + worker（Redis-backed；缺 Redis 时队列连接容错重连）。
  const runtime = new DockerRuntime()
  const queue = new BullMqProvisionQueue({ url: config.redisUrl })
  const orchestrator = new Orchestrator(prisma, runtime, queue, {
    fleetRoot: config.fleetRoot,
    templateDir: config.openclawTemplateDir,
    templateJsonPath: config.openclawTemplateJson,
    image: config.openclawImage,
    llmApiKey: config.llmApiKey,
    portPoolStart: config.portPoolStart,
    portPoolEnd: config.portPoolEnd,
    gatewayTokenBytes: config.gatewayTokenBytes,
    tokenCrypto: createTokenCrypto(config.jwtSecret), // GATEWAY_TOKEN 落库加密（真值不落盘）
  })
  const worker = createProvisioningWorker(orchestrator)
  await orchestrator.reconcileStaleCreating().catch(() => {}) // codex 七轮 P2：启动对账超龄 creating 行

  const app = createApp({ prisma, orchestrator })

  // M0 同进程单端口分流：createServer(expressApp) + server.on('upgrade') 分流。
  // upgrade 钩子由 M4 接 ws 桥（noServer + handleUpgrade + subprotocol 回显）；本期仅 HTTP。
  const server = createServer(app)
  server.on('upgrade', (_req, socket) => {
    // M4 前：无 WS 路由，直接拒绝升级（避免裸挂导致悬空连接）
    socket.destroy()
  })

  const shutdown = async (): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log('[server] 关闭中…')
    await worker.close()
    await queue.close()
    server.close()
    await prisma.$disconnect()
    process.exit(0)
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
