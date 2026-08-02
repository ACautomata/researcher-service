import type { PrismaClient } from './generated/prisma/client'

// 已认证用户的精简投影（路由/中间件只依赖这些字段，不耦合完整 Prisma User 行）。
export interface AuthUser {
  id: string
  username: string
  email: string | null
  role: 'admin' | 'user'
  isActive: boolean
  mustChangePassword: boolean
  maxContainers: number
}

// Express Request 增强：req.user（requireAuth 注入）、req.prisma（createApp 注入）。
declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser
    prisma: PrismaClient
  }
}
