// #775 provider migration behavior test (SCHEMA_VERSION 8→11): usage table + minimax default provider
// per-user seed 幂等（验收 ④「minimax seed 迁移脚本幂等，重跑不产生重复行」）。
//
// 场景矩阵（731 §6 迁移映射末三行）：
//   新形状库 + 零 provider 用户   → seed 一行（重跑不重复——确定性 id + NOT EXISTS 双保险）
//   已有任意 provider 的用户      → 不 seed（「归属按 ownerId 折叠去重」语义）
//   已有 minimax 行（异 id）的用户 → 不 seed（无重复行）
//   旧形状 model_providers 库     → 跳过 seed（旧表不动纪律，留待 T0 #801）
//   llm_usage_records / config_meta 种子 → 到位

import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runDbScript } from './runDbScript'

const MINIMAX_MODELS_JSON =
  '[{"id":"MiniMax-M3","name":"MiniMax M3","reasoning":true,"input":["text","image"],"cost":{"input":0.3,"output":1.2,"cacheRead":0.06,"cacheWrite":0.375},"contextWindow":1048576,"maxTokens":524288}]'

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), `mm-seed-${process.pid}-`))
}

// 新形状最小库：users + 新形状 model_providers（ownerId 列）+ config_meta/provider_endpoints 由
// 增量脚本补齐——模拟 #771 后已收敛的库跑 #775 批次。
function makeV8Db(dbPath: string): void {
  const db = new Database(dbPath)
  try {
    db.exec(`
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "model_providers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "lcProvider" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "credentialEnvId" TEXT,
    "credentialCipher" TEXT,
    "authHeader" BOOLEAN NOT NULL DEFAULT true,
    "modelsJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "model_providers_ownerId_providerId_key" ON "model_providers"("ownerId", "providerId");
INSERT INTO "users" ("id", "username") VALUES ('u-empty', 'empty'), ('u-has', 'has'), ('u-mm', 'mm');
INSERT INTO "model_providers" ("id", "ownerId", "providerId", "lcProvider", "baseUrl", "modelsJson")
VALUES ('existing-1', 'u-has', 'vllm', 'openai', 'https://v.example.com/v1', '[]'),
       ('existing-2', 'u-mm', 'minimax', 'anthropic', 'https://api.minimaxi.com/anthropic', '[]');
PRAGMA user_version=8;
`)
  } finally {
    db.close()
  }
}

// 旧形状库（#771 前部署）：model_providers 带 containerId 列——旧表不动，seed 跳过。
function makeLegacyDb(dbPath: string): void {
  const db = new Database(dbPath)
  try {
    db.exec(`
CREATE TABLE "users" ("id" TEXT NOT NULL PRIMARY KEY, "username" TEXT NOT NULL);
CREATE TABLE "model_providers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "containerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "api" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKeyEnvId" TEXT,
    "authHeader" BOOLEAN NOT NULL DEFAULT true,
    "modelsJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "users" ("id", "username") VALUES ('u-legacy', 'legacy');
PRAGMA user_version=8;
`)
  } finally {
    db.close()
  }
}

describe('#775 迁移批次（llm_usage_records + minimax per-user seed）', () => {
  it('seed：零 provider 用户得一行 minimax；已有 provider/minimax 行的用户不 seed；重跑零重复', () => {
    const dir = makeDir()
    const dbPath = path.join(dir, 'panel.db')
    makeV8Db(dbPath)

    runDbScript('upgrade-schema.mjs', dbPath)
    runDbScript('upgrade-schema.mjs', dbPath) // 幂等重跑

    const db = new Database(dbPath)
    try {
      // u-empty：恰好一行确定性 seed
      const empty = db
        .prepare(`SELECT * FROM model_providers WHERE "ownerId"='u-empty'`)
        .all() as Array<Record<string, unknown>>
      expect(empty).toHaveLength(1)
      expect(empty[0]).toMatchObject({
        id: 'seed-mp-minimax-u-empty',
        providerId: 'minimax',
        lcProvider: 'anthropic',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        credentialEnvId: 'LLM_API_KEY',
        authHeader: 1,
        modelsJson: MINIMAX_MODELS_JSON,
      })
      // u-has（已有 vllm 行）：折叠去重语义——不 seed，原行不动
      const has = db
        .prepare(`SELECT providerId FROM model_providers WHERE "ownerId"='u-has'`)
        .all() as Array<{ providerId: string }>
      expect(has).toEqual([{ providerId: 'vllm' }])
      // u-mm（已有 minimax 行，异 id）：不产生重复行
      const mm = db
        .prepare(`SELECT id, providerId FROM model_providers WHERE "ownerId"='u-mm'`)
        .all() as Array<{ id: string; providerId: string }>
      expect(mm).toEqual([{ id: 'existing-2', providerId: 'minimax' }])
      // 全表行数 = 2 原行 + 1 seed（重跑后仍 3）
      expect((db.prepare(`SELECT COUNT(*) n FROM model_providers`).get() as { n: number }).n).toBe(3)
    } finally {
      db.close()
    }
  })

  it('旧形状 model_providers 库：seed 跳过（旧表不动，留待 T0 #801），其余增量照常', () => {
    const dir = makeDir()
    const dbPath = path.join(dir, 'panel.db')
    makeLegacyDb(dbPath)

    runDbScript('upgrade-schema.mjs', dbPath)

    const db = new Database(dbPath)
    try {
      // 旧表零写入（无 ownerId 列可写，seed 段 guard 跳过）
      const rows = db
        .prepare(`SELECT * FROM model_providers`)
        .all() as Array<Record<string, unknown>>
      expect(rows).toEqual([])
      // 旧形状告警路径不炸、user_version 照常推进、usage 表照常落
      expect(db.pragma('user_version', { simple: true })).toBe(13) // #791 figures 换轨 12→13
      expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='llm_usage_records'`).get(),
      ).toEqual({ name: 'llm_usage_records' })
    } finally {
      db.close()
    }
  })

  it('llm_usage_records 表 + 双核算索引 + config_meta 种子到位', () => {
    const dir = makeDir()
    const dbPath = path.join(dir, 'panel.db')
    makeV8Db(dbPath)

    runDbScript('upgrade-schema.mjs', dbPath)

    const db = new Database(dbPath)
    try {
      const cols = db.prepare('PRAGMA table_info(llm_usage_records)').all() as Array<{ name: string; notnull: number; dflt_value: string | null }>
      expect(cols.map((c) => c.name)).toEqual([
        'id', 'runId', 'sessionId', 'userId', 'username', 'providerId', 'lcProvider', 'model',
        'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'createdAt',
      ])
      // 用量四列 NOT NULL DEFAULT 0（缺省采数不炸）
      for (const col of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
        const c = cols.find((x) => x.name === col)!
        expect(c.notnull, col).toBe(1)
        expect(c.dflt_value, col).toBe('0')
      }
      // 核算索引（按用户+时间窗 / 按模型+时间窗）
      for (const idx of ['llm_usage_records_userId_createdAt_idx', 'llm_usage_records_model_createdAt_idx']) {
        expect(
          db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(idx),
        ).toEqual({ name: idx })
      }
      // config_meta 种子（热生效版本基点）
      expect(
        db.prepare(`SELECT "id", "version" FROM config_meta`).get(),
      ).toEqual({ id: 1, version: 1 })
      // minimax 端点白名单 seed（#803 先例，重跑不重复）
      const eps = db
        .prepare(`SELECT COUNT(*) n FROM provider_endpoints WHERE id='seed-minimax-endpoint'`)
        .get() as { n: number }
      expect(eps.n).toBe(1)
    } finally {
      db.close()
    }
  })
})
