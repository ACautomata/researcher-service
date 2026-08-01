import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from './generated/prisma/client'

// PrismaClient 工厂：Prisma 7 经 driver adapter 注入连接串。
// 测试用 createPrismaClient(testUrl) 注入临时 DB；生产用单例 prisma。
export function createPrismaClient(url: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) })
}

let singleton: PrismaClient | null = null

export function getPrisma(): PrismaClient {
  if (singleton) return singleton
  // 延迟引入 config 以避免测试环境 dotenv 副作用
  const { config } = require('./config')
  singleton = createPrismaClient(config.databaseUrl)
  return singleton
}
