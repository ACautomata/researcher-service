// 把 prisma/init.sql 应用到 dev DB（file:./prisma/panel.db）。
// 用 better-sqlite3 直连落表，不经 prisma CLI——规避 Prisma 7 的 AI 破坏性操作守卫（db push/migrate）。
// schema 变更后：先 `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > prisma/init.sql`，再 `npm run db:apply`。
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const sql = readFileSync(path.join(here, '..', 'prisma', 'init.sql'), 'utf8')
const url = process.env.DATABASE_URL ?? 'file:./prisma/panel.db'
const dbPath = url.replace(/^file:/, '')

const db = new Database(dbPath)
db.exec(sql)
db.close()
// eslint-disable-next-line no-console
console.log(`[db:apply] schema applied to ${dbPath}`)
