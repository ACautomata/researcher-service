import path from 'node:path'
import { defineConfig } from '@prisma/config'

// Prisma 7：schema 内 datasource 不写 url。
// - CLI（generate/validate/migrate/db push）从这里的 datasource.url 取连接串。
// - 运行时 PrismaClient 不读本文件，由 src/prisma.ts 的 driver adapter 注入同一 DB。
//   （runtime 用 better-sqlite3 adapter；CLI 经典引擎直连 file:，两者指向同一文件。）
const dbUrl = process.env.DATABASE_URL ?? 'file:./prisma/panel.db'

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: { path: path.join('prisma', 'migrations'), initShadowDb: false },
  datasource: { url: dbUrl },
})
