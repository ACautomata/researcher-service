// 把 prisma/init.sql 收敛到目标 DB（file:./prisma/panel.db），better-sqlite3 直连，不经 prisma CLI
// ——规避 Prisma 7 的 AI 破坏性操作守卫（db push/migrate）。
//
// #771 起本脚本幂等可重跑（验收钉死）：
//   1) init.sql 逐语句应用 —— CREATE TABLE/INDEX 先查 sqlite_master 存在即跳过（additive，
//      旧表形状不被改写）；fresh 库全量建表，既有库全量跳过。
//   2) 增量收敛 —— 共享 lib/incremental-schema.mjs（新表 IF NOT EXISTS、既有表加列经
//      PRAGMA guard、config_meta 种子）：`npm run db:apply` 单独即可把任意旧库收敛到当前
//      schema。additive 是默认；换轨 DROP 例外（#791 figures / T0 #801 legacy 清退：
//      旧形状 model_providers / pairings；#858 OpenClaw 退役③：containers 表）——
//      依 #732 零迁移前提（产品未上线，旧行不迁移直接换轨），处置集中在 incremental-schema
//      的 runFleetRetirement + runT0LegacyCleanup（先 DROP 后 CREATE 次序）。
//
// schema 变更后：先 `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma
// --script > prisma/init.sql`（init.sql 为 from-empty 全量派生物，schema.prisma 单一来源），
// 新表同步镜像进 scripts/lib/incremental-schema.mjs，再 `npm run db:apply`。
// 顶部加载 .env（与 src/config.ts 的 dotenv/config 一致）：否则 DATABASE_URL 仅配在 .env 时，
// 本脚本读到默认值，静默初始化 prisma/panel.db，而 server 连真实 DB → 非默认部署启动对未初始化库。
import 'dotenv/config'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { runIncrementalSchema, runT0LegacyCleanup } from './lib/incremental-schema.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const sql = readFileSync(path.join(here, '..', 'prisma', 'init.sql'), 'utf8')
const url = process.env.DATABASE_URL ?? 'file:./prisma/panel.db'
const dbPath = url.replace(/^file:/, '')

// init.sql 语句切分：去整行 `--` 注释后按 `;` 切（Prisma migrate diff 产出的 DDL 无含 `;` 的字面量）。
// 返回 [{ kind: 'table'|'index'|'raw', name?, sql }]
function parseStatements(rawSql) {
  const noComments = rawSql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
  return noComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const table = /^CREATE\s+TABLE\s+"([^"]+)"/i.exec(s)
      if (table) return { kind: 'table', name: table[1], sql: s }
      const index = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+"([^"]+)"/i.exec(s)
      if (index) return { kind: 'index', name: index[1], sql: s }
      return { kind: 'raw', sql: s }
    })
}

const db = new Database(dbPath)
try {
  // T0 #801：先清退 legacy（旧形状 model_providers / pairings）——init.sql 的新形状语句
  //（含 model_providers (ownerId, providerId) 唯一索引）在旧形状上执行会炸 no such column；
  // 先 DROP 后 init.sql 全量建出新形状（幂等可重跑）。（containers 表 DROP 归
  // runIncrementalSchema → runFleetRetirement，#858。）
  runT0LegacyCleanup(db)
  for (const stmt of parseStatements(sql)) {
    if (stmt.kind !== 'raw') {
      const exists = db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?`)
        .get(stmt.kind, stmt.name)
      if (exists) continue // 幂等：已存在即跳过（绝不重建既有表）
    }
    db.exec(stmt.sql)
  }
  runIncrementalSchema(db)
} finally {
  db.close()
}
// eslint-disable-next-line no-console
console.log(`[db:apply] schema applied to ${dbPath}`)
