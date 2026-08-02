import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import supertest, { type SuperTest, type Test } from 'supertest'
import type { Application } from 'express'
import { createPrismaClient } from '../src/prisma'
import { createApp, type AppDeps } from '../src/app'
import type { PrismaClient } from '../src/generated/prisma/client'

// 接缝 #2 测试基座：每测试文件独立临时 SQLite（forks 池隔离进程）。
// 建表经 better-sqlite3 直读 prisma/init.sql（prisma migrate diff 产出）——
// 不经 prisma CLI（避免 Prisma 7 的 AI 破坏性操作守卫 + 更快），随后 PrismaClient
// 经 driver adapter 连同一文件。init.sql 随 schema 改动后用 npm run 重新生成。
const INIT_SQL = readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8')

export interface TestContext {
  prisma: PrismaClient
  app: Application
  request: SuperTest<Test>
  dbUrl: string
  cleanup: () => Promise<void>
}

let seq = 0

// extraDeps：可选注入编排器等（接缝 #5 containers 测试注入假 runtime + inline queue）。
export async function setupTestApp(extraDeps: Omit<AppDeps, 'prisma'> = {}): Promise<TestContext> {
  const dir = mkdtempSync(path.join(tmpdir(), `panel-test-${process.pid}-${seq++}-`))
  const dbPath = path.join(dir, 'test.db')
  const sqlite = new Database(dbPath)
  sqlite.exec(INIT_SQL)
  sqlite.close()

  const dbUrl = `file:${dbPath}`
  process.env.DATABASE_URL = dbUrl
  process.env.NODE_ENV = 'test'

  const prisma = createPrismaClient(dbUrl)
  const app = createApp({ prisma, ...extraDeps })
  return {
    prisma,
    app,
    request: supertest(app) as unknown as SuperTest<Test>,
    dbUrl,
    cleanup: async () => {
      await prisma.$disconnect()
    },
  }
}
