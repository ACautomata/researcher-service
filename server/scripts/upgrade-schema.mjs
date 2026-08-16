// Incremental SQLite schema upgrades for existing panel databases.
//
// apply-schema.mjs initializes an empty database from prisma/init.sql. Existing
// deployments skip that path because base tables already exist, so new tables
// must be added here with idempotent DDL.
import 'dotenv/config'
import Database from 'better-sqlite3'

const url = process.env.DATABASE_URL ?? 'file:./prisma/panel.db'
const dbPath = url.replace(/^file:/, '')

const db = new Database(dbPath)
try {
  db.exec(`
CREATE TABLE IF NOT EXISTS "text_trace_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "traceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "containerName" TEXT,
    "sessionKey" TEXT,
    "runId" TEXT,
    "inputText" TEXT NOT NULL DEFAULT '',
    "outputText" TEXT NOT NULL DEFAULT '',
    "outputHash" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'success',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "text_trace_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "text_trace_logs_traceId_key" ON "text_trace_logs"("traceId");
CREATE INDEX IF NOT EXISTS "text_trace_logs_userId_idx" ON "text_trace_logs"("userId");
CREATE INDEX IF NOT EXISTS "text_trace_logs_ipAddress_idx" ON "text_trace_logs"("ipAddress");
CREATE INDEX IF NOT EXISTS "text_trace_logs_createdAt_idx" ON "text_trace_logs"("createdAt");
CREATE INDEX IF NOT EXISTS "text_trace_logs_status_idx" ON "text_trace_logs"("status");

CREATE TABLE IF NOT EXISTS "figures" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "figures_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "generation_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "figureId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "generation_jobs_figureId_fkey" FOREIGN KEY ("figureId") REFERENCES "figures" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "figures_ownerId_idx" ON "figures"("ownerId");
CREATE UNIQUE INDEX IF NOT EXISTS "generation_jobs_figureId_key" ON "generation_jobs"("figureId");
`)

  // T02 幂等（grilling §17）：既有 figures 表（T01 前已建）缺 idempotencyKey 列。ADD COLUMN
  // 非天然幂等（重复执行报 duplicate column），先查 PRAGMA table_info 再补；唯一索引本身
  // 幂等（IF NOT EXISTS）。fresh 库（上方 CREATE TABLE 已带列）此处列存在 → guard 跳过。
  const figureCols = db.prepare(`PRAGMA table_info("figures")`).all()
  if (!figureCols.some((c) => c.name === 'idempotencyKey')) {
    db.exec(`ALTER TABLE "figures" ADD COLUMN "idempotencyKey" TEXT`)
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS "figures_ownerId_idempotencyKey_key" ON "figures"("ownerId", "idempotencyKey")`,
  )

  db.pragma('user_version = 4')
} finally {
  db.close()
}

// eslint-disable-next-line no-console
console.log(`[db:upgrade] schema upgraded to user_version=4 at ${dbPath}`)
