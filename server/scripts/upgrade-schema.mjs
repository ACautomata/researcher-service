// Incremental SQLite schema upgrades for existing panel databases（docker-entrypoint 每次启动调用）。
//
// apply-schema.mjs 对空库做全量初始化（prisma/init.sql）；既有部署跳过该路径（users 表已存在），
// 新表/新列全部经本脚本 additive 收敛（幂等可重跑）。具体 DDL 与铁律见 lib/incremental-schema.mjs。
import 'dotenv/config'
import Database from 'better-sqlite3'
import { runIncrementalSchema, SCHEMA_VERSION } from './lib/incremental-schema.mjs'

const url = process.env.DATABASE_URL ?? 'file:./prisma/panel.db'
const dbPath = url.replace(/^file:/, '')

const db = new Database(dbPath)
try {
  runIncrementalSchema(db)
  db.pragma(`user_version = ${SCHEMA_VERSION}`)
} finally {
  db.close()
}

// eslint-disable-next-line no-console
console.log(`[db:upgrade] schema upgraded to user_version=${SCHEMA_VERSION} at ${dbPath}`)
