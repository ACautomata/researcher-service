import { createServer } from 'node:http'
import { createApp } from './app'
import { getPrisma } from './prisma'
import { bootstrap } from './auth/bootstrap'
import { config } from './config'
import './types'

async function main(): Promise<void> {
  const prisma = getPrisma()
  await bootstrap(prisma) // B1 惰性首启（空表生成 admin）
  const app = createApp({ prisma })

  // M0 同进程单端口分流：createServer(expressApp) + server.on('upgrade') 分流。
  // upgrade 钩子由 M4 接 ws 桥（noServer + handleUpgrade + subprotocol 回显）；本期仅 HTTP。
  const server = createServer(app)
  server.on('upgrade', (_req, socket) => {
    // M4 前：无 WS 路由，直接拒绝升级（避免裸挂导致悬空连接）
    socket.destroy()
  })

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
