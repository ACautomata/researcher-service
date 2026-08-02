import express, { type Application, type Request, type Response, type NextFunction } from 'express'
import cookieParser from 'cookie-parser'
import type { PrismaClient } from './generated/prisma/client'
import { healthRouter } from './routes/health'
import { authRouter } from './routes/auth'
import { usersRouter } from './routes/users'
import { createContainersRouter } from './routes/containers'
import { envelopeErrorHandler, notFound } from './middleware/errorHandler'
import type { Orchestrator } from './orchestrator/orchestrator'
import './types' // Express Request 增强（req.user / req.prisma）

export interface AppDeps {
  prisma: PrismaClient
  orchestrator?: Orchestrator // M2：容器编排器（可注入；测试/未装配时跳过 containers 挂载）
}

// createApp 工厂：PrismaClient 经依赖注入，测试可传 test DB（接缝 #2）。
export function createApp({ prisma, orchestrator }: AppDeps): Application {
  const app = express()
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
    app.use('/api/v1/containers', createContainersRouter({ prisma, orchestrator }))
  }

  app.use(notFound) // 未匹配路由 → 信封 90005（兑现「所有 REST HTTP 200」）
  app.use(envelopeErrorHandler) // 唯一错误面（必须最后挂载）
  return app
}
