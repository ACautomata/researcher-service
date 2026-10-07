import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runDbScript } from './runDbScript'

// 从「只有 base 表」的旧库跑全量增量脚本（幂等跑两遍）→ 全表到位 + #791 AutoFigure 换轨
//（figures 新形状重建 + generation_jobs 退役）+ #699 upgradeAttempts 列 + teammate/mailbox
// + user_version 归 14（#771 批次 7→8；#775 8→9；#787 9→10；#786 10→11；#785 11→12；
// #790 teammates.kind + #791 figures 换轨 12→13）。
function assertUpgraded(dbPath: string): void {
  const db = new Database(dbPath)
  try {
    // better-sqlite3 命名参数经对象绑定（$name）；表/索引名来自上方常量数组，无注入面。
    for (const table of ['text_trace_logs', 'figures']) {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=$name").get({ name: table }),
      ).toEqual({ name: table })
    }
    // #791（#744 §5.2）：GenerationJob 退役——执行状态机归 run 域，表不得残留
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='generation_jobs'").get(),
    ).toBeUndefined()
    for (const index of ['text_trace_logs_traceId_key', 'figures_ownerId_idx']) {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=$name").get({ name: index }),
      ).toEqual({ name: index })
    }
    // #791 幂等唯一索引随换轨退役（Idempotency-Key 机制随 REST 创建端点退役）
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='figures_ownerId_idempotencyKey_key'")
        .get(),
    ).toBeUndefined()
    // figures 新形状持久化契约（#744 §5.1）：svg（final SVG 文本）+ png（BLOB）+ evaluation
    //（pipeline 元数据 JSON）+ sessionId（溯源）全 nullable；旧列（xml/idempotencyKey）不残留。
    const figureCols = db.prepare('PRAGMA table_info(figures)').all() as Array<{ name: string; notnull: number }>
    for (const col of ['svg', 'png', 'evaluation', 'sessionId']) {
      const c = figureCols.find((x) => x.name === col)
      expect(c, col).toBeDefined()
      expect(c!.notnull).toBe(0) // nullable
    }
    for (const col of ['xml', 'idempotencyKey']) {
      expect(figureCols.find((x) => x.name === col), `${col} 应已退役`).toBeUndefined()
    }
    // T0 #801：upgradeAttempts 列随 #699 升级编排退役——增量收敛须 DROP 既有库残留列。
    const containerCols = db.prepare('PRAGMA table_info(containers)').all() as Array<{ name: string }>
    expect(containerCols.find((c) => c.name === 'upgradeAttempts'), 'upgradeAttempts 应已退役').toBeUndefined()
    // port 唯一索引随端口池废除一并清退
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='containers_port_key'").get()).toBeUndefined()
    // pairings 表随设备配对全链退役
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pairings'").get()).toBeUndefined()
    expect(db.pragma('user_version', { simple: true })).toBe(14) // #790/#791 批次 12→13；T0 #801 legacy 清退 13→14
    const sessionCols = db.prepare('PRAGMA table_info("sessions")').all() as Array<{ name: string }>
    expect(sessionCols.some((col) => col.name === 'isTeammate')).toBe(true)
    expect(sessionCols.some((col) => col.name === 'preferredModelJson')).toBe(true)
    for (const table of ['teammates', 'teammate_mailbox_messages', 'teammate_mailbox_waits']) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)).toEqual({ name: table })
    }
    // #785 覆盖审计表（write-after-write 审计域）
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get('file_overwrite_logs'),
    ).toEqual({ name: 'file_overwrite_logs' })
  } finally {
    db.close()
  }
}

function makeBaseDb(dbPath: string): void {
  const db = new Database(dbPath)
  try {
    db.exec(`
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "maxContainers" INTEGER NOT NULL DEFAULT 3,
    "oidcSubject" TEXT,
    "oidcIssuer" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "containers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "ownerId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tokenEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "homeDir" TEXT NOT NULL,
    "containerId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'creating',
    "image" TEXT NOT NULL,
    "leaseExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
PRAGMA user_version=1;
`)
  } finally {
    db.close()
  }
}

describe('schema upgrade script', () => {
  it('adds text trace + AutoFigure tables to an existing base database and is idempotent', () => {
    const dir = mkdtempSync(path.join(tmpdir(), `schema-upgrade-${process.pid}-`))
    const dbPath = path.join(dir, 'panel.db')
    makeBaseDb(dbPath)

    runDbScript('upgrade-schema.mjs', dbPath)
    runDbScript('upgrade-schema.mjs', dbPath)

    assertUpgraded(dbPath)
  })

  it('upgrades an already-text-trace DB (v2) to current tables + user_version=14', () => {
    const dir = mkdtempSync(path.join(tmpdir(), `schema-upgrade-${process.pid}-`))
    const dbPath = path.join(dir, 'panel.db')
    // 模拟上一轮增量已交付 text_trace_logs 的既有部署（v2）——增量脚本须只补 figures + 换轨
    // + containers.upgradeAttempts（#699）。containers 表为 v1 起就有的 base 表，一并种上（缺列）。
    const db = new Database(dbPath)
    try {
      db.exec(`
CREATE TABLE "text_trace_logs" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "containers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "ownerId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tokenEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "homeDir" TEXT NOT NULL,
    "containerId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'creating',
    "image" TEXT NOT NULL,
    "leaseExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
PRAGMA user_version=2;
`)
    } finally {
      db.close()
    }

    runDbScript('upgrade-schema.mjs', dbPath)
    runDbScript('upgrade-schema.mjs', dbPath) // 幂等：第二遍不报错、不重复建表

    assertUpgraded(dbPath)
  })

  it('#791 legacy AutoFigure shapes are replaced (figures 旧形状 + generation_jobs → 新形状)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), `schema-legacy791-${process.pid}-`))
    const dbPath = path.join(dir, 'panel.db')
    // 模拟 #791 前的完整旧形状部署：figures 带 xml/idempotencyKey（含旧行）+ generation_jobs
    // 带执行列与遗留 queued 行 → 换轨后旧行删除（#732 零迁移前提）、Job 表退役、新形状落位。
    const db = new Database(dbPath)
    try {
      db.exec(`
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "maxContainers" INTEGER NOT NULL DEFAULT 3,
    "oidcSubject" TEXT,
    "oidcIssuer" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "containers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "ownerId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tokenEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "homeDir" TEXT NOT NULL,
    "containerId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'creating',
    "image" TEXT NOT NULL,
    "leaseExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "figures" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "xml" TEXT,
    "png" BLOB,
    "evaluation" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "generation_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "figureId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "figures_ownerId_idempotencyKey_key" ON "figures"("ownerId", "idempotencyKey");
INSERT INTO "figures" ("id","ownerId","prompt","updatedAt") VALUES ('f-legacy','u1','old mxgraph', CURRENT_TIMESTAMP);
INSERT INTO "generation_jobs" ("id","figureId","updatedAt") VALUES ('j-legacy','f-legacy', CURRENT_TIMESTAMP);
PRAGMA user_version=12;
`)
    } finally {
      db.close()
    }

    runDbScript('upgrade-schema.mjs', dbPath)
    runDbScript('upgrade-schema.mjs', dbPath) // 幂等重跑

    assertUpgraded(dbPath)
    const check = new Database(dbPath)
    try {
      // 旧 Figure 行不迁移（#732 零迁移前提：直接换轨删除）
      expect(check.prepare('SELECT COUNT(*) n FROM figures').get()).toEqual({ n: 0 })
    } finally {
      check.close()
    }
  })
})
