// Incremental SQLite schema upgrades for existing panel databases（docker-entrypoint 每次启动调用）。
//
// apply-schema.mjs 对空库做全量初始化（prisma/init.sql）；既有部署跳过该路径（users 表已存在），
// 新表/新列全部经本脚本 additive 收敛（幂等可重跑）。具体 DDL 与铁律见 lib/incremental-schema.mjs。
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runIncrementalSchema, SCHEMA_VERSION } from './lib/incremental-schema.mjs'

const url = process.env.DATABASE_URL ?? 'file:./prisma/panel.db'
const dbPath = url.replace(/^file:/, '')
const here = path.dirname(fileURLToPath(import.meta.url))
// #1084：来源失效触发器须在既有库的每次启动收敛（与 db:apply 同一份 SQL，幂等）。
const reflectionTriggersSql = readFileSync(path.join(here, '..', 'prisma', 'reflection-triggers.sql'), 'utf8')

const db = new Database(dbPath)
try {
  runIncrementalSchema(db)
  db.exec(reflectionTriggersSql)
  // 旧版本升级接缝允许仅含部分基础表；完整库才安装账号级触发器。
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get()) {
    db.exec(readFileSync(path.join(here, '..', 'prisma', 'reflection-owner-trigger.sql'), 'utf8'))
  }
  db.pragma(`user_version = ${SCHEMA_VERSION}`)
} finally {
  db.close()
}

// eslint-disable-next-line no-console
console.log(`[db:upgrade] schema upgraded to user_version=${SCHEMA_VERSION} at ${dbPath}`)
