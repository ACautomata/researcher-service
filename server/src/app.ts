import express, { type Application, type Request, type Response, type NextFunction } from 'express'
import cookieParser from 'cookie-parser'
import type { PrismaClient } from './generated/prisma/client'
import { healthRouter } from './routes/health'
import { authRouter } from './routes/auth'
import { usersRouter } from './routes/users'
import { createContainersRouter } from './routes/containers'
import { createWikiRouter, type WikiRouterDeps } from './wiki/routes'
import { Orchestrator } from './containers/orchestrator'
import { FleetDeps } from './containers/deps'
import type { ContainerRuntime } from './containers/runtime'
import type { FleetConfig } from './containers/values'
import { envelopeErrorHandler, notFound } from './middleware/errorHandler'
import './types' // Express Request 增强（req.user / req.prisma）

export interface AppDeps {
  prisma: PrismaClient
  // 容器编排接缝（#334）：测试注入假 runtime + inline queue + tmp fleet config；
  // 生产由 server.ts 装真 DockerRuntime + BullMQ 队列。缺省 = 无编排（containers 路由不挂）。
  orchestrator?: Orchestrator
  // wiki 接缝（#335）：compile 触发等。缺省 = no-op（无编排）。
  wiki?: WikiRouterDeps
}

// createApp 工厂：PrismaClient 经依赖注入，测试可传 test DB（接缝 #2）。
export function createApp({ prisma, orchestrator, wiki }: AppDeps): Application {
  const app = express()
  // wiki 内容契约无大小上限（codex PR#346）：挂载路径内请求先走 5mb limit，其余端点仍 256kb。
  // 须先于全局 parser —— body-parser 对已解析 body（req._body）会跳过，故 wiki 命中后不二次解析。
  app.use('/api/v1/containers/:name/wiki', express.json({ limit: '5mb' }))
  app.use(express.json({ limit: '256kb' }))
  app.use(cookieParser())
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.prisma = prisma
    next()
  })

  app.use('/api', healthRouter)
  app.use('/api/v1/auth', authRouter)
  app.use('/api/v1/users', usersRouter)
  if (orchestrator) {
    app.use('/api/v1/containers', createContainersRouter(orchestrator))
  }
  // wiki（#335）：只依赖 prisma + 容器行 homeDir，不依赖编排器；compile 触发经 wiki 注入。
  // 注意：Express 5 不把 app.use 挂载路径的 :name 合并进 router 的 req.params，故挂到
  // /api/v1/containers、把 `/:name/wiki/...` 路径声明在 router 内部（见 wiki/routes.ts）。
  app.use('/api/v1/containers', createWikiRouter(wiki ?? {}))

  app.use(notFound) // 未匹配路由 → 信封 90005（兑现「所有 REST HTTP 200」）
  app.use(envelopeErrorHandler) // 唯一错误面（必须最后挂载）
  return app
}

// 生产装配：由 server.ts 调用（DockerRuntime + BullMQ 队列），返回编排器与资源句柄供优雅关闭。
export interface FleetAssembly {
  orchestrator: Orchestrator
  deps: FleetDeps
}

export type { ContainerRuntime, FleetConfig }
