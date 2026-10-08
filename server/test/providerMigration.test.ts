// #881 v15→v16 收敛迁移行为测试：端点预设制换轨（model_providers copy-rebuild 归一 +
// provider_endpoints 白名单表退役 + minimax per-user 种子退役 + plugin_llm_assignments 备用表）。
//
// 场景矩阵（#881 AC「v15 形状库跑收敛」）：
//   v15 形状库：已知 host 行归一到对应预设 / 未知 host 行丢弃 + 逐行告警 /
//               seed-mp-minimax-* 种子行退役（零 provider 用户不再落种子行）/
//               credentialCipher 统一 NULL（平台共享 key）
//   v15 库收敛后：provider_endpoints 白名单表消失（含其种子行）
//   幂等：重跑零变化；v16 形状库直跑跳过 copy-rebuild
//   更旧形状（containerId）库：T0 #801 DROP 重建路径仍通（v16 直建，无种子）
//   host 归一映射与预设清单同源（import TS presets 断言，漂移即红）

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runDbScript } from './runDbScript'
import { ENDPOINT_PRESETS } from '../src/models/presets'

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), `mm-v16-${process.pid}-`))
}

const MINIMAX_MODELS_JSON =
  '[{"id":"MiniMax-M3","name":"MiniMax M3","reasoning":true,"input":["text","image"],"cost":{"input":0.3,"output":1.2,"cacheRead":0.06,"cacheWrite":0.375},"contextWindow":1048576,"maxTokens":524288}]'

// v15 形状最小库：#771 后已收敛形状（lcProvider/baseUrl/credentialEnvId/authHeader）+
// provider_endpoints 白名单表 + per-user minimax seed 行 + sessions/teammates 存量引用
// （seed providerId 'minimax' 的 /model 偏好与 teammate 指派——remap 断言面）。
function makeV15Db(dbPath: string): void {
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
CREATE TABLE "provider_endpoints" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scheme" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "preferredModelJson" TEXT
);
CREATE TABLE "teammates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "parentSessionId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT '',
    "modelProviderId" TEXT
);
INSERT INTO "users" ("id", "username") VALUES ('u-empty', 'empty'), ('u-byok', 'byok'), ('u-seedonly', 'seedonly'), ('u-unknown', 'unknown');
INSERT INTO "provider_endpoints" ("id", "scheme", "host", "port", "note", "createdBy")
VALUES ('seed-minimax-endpoint', 'https', 'api.minimaxi.com', NULL, 'seed（731 §3.1）：默认 minimax 端点', ''),
       ('admin-entry', 'https', 'v.example.com', NULL, '', 'u-byok');
INSERT INTO "model_providers" ("id", "ownerId", "providerId", "lcProvider", "baseUrl", "credentialEnvId", "authHeader", "modelsJson")
VALUES ('seed-mp-minimax-u-seedonly', 'u-seedonly', 'minimax', 'anthropic', 'https://api.minimaxi.com/anthropic', 'LLM_API_KEY', 1, '${MINIMAX_MODELS_JSON.replace(/'/g, "''")}'),
       ('byok-anthropic', 'u-byok', 'my-claude', 'anthropic', 'https://api.anthropic.com', 'LLM_API_KEY', 1, '[{"id":"claude-sonnet-5-5"}]'),
       ('byok-openai', 'u-byok', 'my-gpt', 'openai', 'https://api.openai.com/v1', 'LLM_API_KEY', 1, '[{"id":"gpt-5.1"}]'),
       ('byok-own-minimax', 'u-byok', 'minimax', 'anthropic', 'https://api.anthropic.com', 'LLM_API_KEY', 1, '[{"id":"claude-sonnet-5-5"}]'),
       ('orphan-vllm', 'u-unknown', 'vllm', 'openai', 'https://v.example.com/v1', 'LLM_API_KEY', 1, '[]'),
       ('mm-openai-face', 'u-unknown', 'mx-face', 'openai', 'https://api.minimaxi.com/v1', 'LLM_API_KEY', 1, '[{"id":"MiniMax-Text-01"}]'),
       ('squat-platform', 'u-unknown', 'platform', 'anthropic', 'https://api.anthropic.com', 'LLM_API_KEY', 1, '[]');
INSERT INTO "sessions" ("id", "ownerId", "preferredModelJson")
VALUES ('s-seed-pinned', 'u-seedonly', '{"providerId":"minimax","modelId":"MiniMax-M3"}'),
       ('s-byok-pinned', 'u-byok', '{"providerId":"minimax","modelId":"MiniMax-M3"}'),
       ('s-openai-pinned', 'u-byok', '{"providerId":"my-gpt","modelId":"gpt-5.1"}'),
       ('s-no-pref', 'u-empty', NULL);
INSERT INTO "teammates" ("id", "parentSessionId", "threadId", "name", "modelProviderId")
VALUES ('t-seed', 's-seed-pinned', 'thread-seed', 'tm-seed', 'minimax'),
       ('t-own', 's-byok-pinned', 'thread-own', 'tm-own', 'minimax'),
       ('t-openai', 's-openai-pinned', 'thread-openai', 'tm-openai', 'my-gpt');
PRAGMA user_version=15;
`)
  } finally {
    db.close()
  }
}

// 更旧形状库（#771 前部署）：model_providers 带 containerId 列——T0 #801 检测即 DROP。
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

interface MpRow {
  id: string
  ownerId: string
  providerId: string
  presetId: string
  credentialCipher: string | null
  modelsJson: string
}

function rows(db: Database.Database, where = ''): MpRow[] {
  return db
    .prepare(`SELECT id, "ownerId" AS ownerId, providerId, presetId, credentialCipher, modelsJson FROM model_providers ${where} ORDER BY id`)
    .all() as MpRow[]
}

afterEach(() => vi.restoreAllMocks())

describe('#881 v15→v16 收敛迁移（端点预设制换轨）', () => {
  it('v15 库：已知 host 行归一到预设；未知 host 行丢弃+告警；seed 行退役；cipher 统一 NULL', () => {
    const dbPath = path.join(makeDir(), 'panel.db')
    makeV15Db(dbPath)

    runDbScript('upgrade-schema.mjs', dbPath)

    const db = new Database(dbPath)
    try {
      // 已知 host+协议行逐行归一（id/providerId/modelsJson 原样保留；presetId 按归一映射；cipher NULL）。
      // u-byok 自建 providerId='minimax' 行原样保留（引用 remap 的保护对象）。
      expect(rows(db, `WHERE "ownerId"='u-byok'`)).toEqual([
        { id: 'byok-anthropic', ownerId: 'u-byok', providerId: 'my-claude', presetId: 'anthropic', credentialCipher: null, modelsJson: '[{"id":"claude-sonnet-5-5"}]' },
        { id: 'byok-openai', ownerId: 'u-byok', providerId: 'my-gpt', presetId: 'openai', credentialCipher: null, modelsJson: '[{"id":"gpt-5.1"}]' },
        { id: 'byok-own-minimax', ownerId: 'u-byok', providerId: 'minimax', presetId: 'anthropic', credentialCipher: null, modelsJson: '[{"id":"claude-sonnet-5-5"}]' },
      ])
      // seed-mp-minimax-* 退役：零 provider 用户（u-seedonly）不再落种子行
      expect(rows(db, `WHERE "ownerId"='u-seedonly'`)).toEqual([])
      // u-unknown 三行全丢：未知 host / 同 host 异协议（MiniMax OpenAI 兼容面）/ 保留 id 抢注
      expect(rows(db, `WHERE "ownerId"='u-unknown'`)).toEqual([])
      // v16 形状列就位，v15 旧列不残留
      const cols = (db.prepare('PRAGMA table_info(model_providers)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(cols).toEqual(['id', 'ownerId', 'providerId', 'presetId', 'credentialCipher', 'modelsJson', 'createdAt'])
      // 白名单表整表退役（含其种子行）
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='provider_endpoints'`).get()).toBeUndefined()
      expect(db.pragma('user_version', { simple: true })).toBe(16)
      // 退役 seed id 'minimax' 引用 remap：无自建行的 owner 改指平台虚拟条目；有自建行不动
      const pref = (id: string): string | null =>
        (db.prepare(`SELECT "preferredModelJson" p FROM "sessions" WHERE id=?`).get(id) as { p: string | null }).p
      expect(JSON.parse(pref('s-seed-pinned')!)).toEqual({ providerId: 'platform', modelId: 'MiniMax-M3' })
      expect(JSON.parse(pref('s-byok-pinned')!)).toEqual({ providerId: 'minimax', modelId: 'MiniMax-M3' }) // 自建行在，引用不动
      expect(JSON.parse(pref('s-openai-pinned')!)).toEqual({ providerId: 'my-gpt', modelId: 'gpt-5.1' }) // 非 minimax 引用不动
      expect(pref('s-no-pref')).toBeNull()
      const tm = (id: string): string | null =>
        (db.prepare(`SELECT "modelProviderId" m FROM "teammates" WHERE id=?`).get(id) as { m: string | null }).m
      expect(tm('t-seed')).toBe('platform') // 经 parentSessionId → sessions.ownerId 判定无自建行
      expect(tm('t-own')).toBe('minimax') // u-byok 有自建行，不动
      expect(tm('t-openai')).toBe('my-gpt')
    } finally {
      db.close()
    }
  })

  it('未知 host 行逐行 console.warn 告警（行数与行 id 可追溯）', async () => {
    const dbPath = path.join(makeDir(), 'panel.db')
    makeV15Db(dbPath)

    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(' '))
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // @ts-expect-error -- .mjs 无 d.ts（纯 JS 迁移脚本）
    const mod = (await import('../scripts/lib/incremental-schema.mjs')) as { runIncrementalSchema(db: Database.Database): void }
    const db = new Database(dbPath)
    try {
      ;(mod.runIncrementalSchema as (d: Database.Database) => void)(db)
    } finally {
      db.close()
    }
    const orphan = warns.filter((w) => w.includes('orphan-vllm'))
    expect(orphan).toHaveLength(1)
    expect(orphan[0]).toContain('v.example.com')
    expect(spy).toHaveBeenCalled()
  })

  it('幂等重跑：v16 库再跑收敛零变化', () => {
    const dbPath = path.join(makeDir(), 'panel.db')
    makeV15Db(dbPath)
    runDbScript('upgrade-schema.mjs', dbPath)

    const db = new Database(dbPath)
    const before = rows(db)
    db.close()
    runDbScript('upgrade-schema.mjs', dbPath) // 重跑

    const db2 = new Database(dbPath)
    try {
      expect(rows(db2)).toEqual(before)
      expect(db2.pragma('user_version', { simple: true })).toBe(16)
    } finally {
      db2.close()
    }
  })

  it('更旧形状（containerId）库：T0 DROP 后 v16 直建，无种子行', () => {
    const dbPath = path.join(makeDir(), 'panel.db')
    makeLegacyDb(dbPath)

    runDbScript('upgrade-schema.mjs', dbPath)

    const db = new Database(dbPath)
    try {
      expect(rows(db)).toEqual([]) // 零迁移前提：旧行不迁移、无种子补偿
      const cols = (db.prepare('PRAGMA table_info(model_providers)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(cols).toContain('presetId')
      expect(cols).not.toContain('containerId')
      expect(db.pragma('user_version', { simple: true })).toBe(16)
    } finally {
      db.close()
    }
  })

  it('plugin_llm_assignments 备用表到位（复合主键 ownerId+pluginId；级联 users）', () => {
    const dbPath = path.join(makeDir(), 'panel.db')
    makeV15Db(dbPath)
    runDbScript('upgrade-schema.mjs', dbPath)

    const db = new Database(dbPath)
    try {
      expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_llm_assignments'`).get(),
      ).toEqual({ name: 'plugin_llm_assignments' })
      const cols = db.prepare('PRAGMA table_info(plugin_llm_assignments)').all() as Array<{ name: string; pk: number }>
      expect(cols.filter((c) => c.pk > 0).map((c) => c.name).sort()).toEqual(['ownerId', 'pluginId'])
      // 级联：删用户清指派行（updatedAt 由测试显式置位——DDL 无默认，Prisma @updatedAt 在 client 层注入）
      db.prepare(`INSERT INTO plugin_llm_assignments ("ownerId", "pluginId", "updatedAt") VALUES ('u-byok', 'autofigure', CURRENT_TIMESTAMP)`).run()
      db.prepare(`DELETE FROM users WHERE id='u-byok'`).run()
      expect(
        (db.prepare(`SELECT COUNT(*) n FROM plugin_llm_assignments WHERE "ownerId"='u-byok'`).get() as { n: number }).n,
      ).toBe(0)
    } finally {
      db.close()
    }
  })

  it('host 归一映射与预设清单同源（迁移内联表 ⊆/⊇ 预设 baseUrl host 集）', async () => {    // 迁移脚本（.mjs）不能 import TS——同源性经本测试钉死：对每个预设 host，
    // 造一行 v15 数据跑收敛，断言归一到对应预设 id。
    const db = new Database(':memory:')
    try {
      db.exec(`
CREATE TABLE "users" ("id" TEXT NOT NULL PRIMARY KEY, "username" TEXT NOT NULL);
INSERT INTO "users" ("id", "username") VALUES ('u', 'u');
CREATE TABLE "model_providers" (
    "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "providerId" TEXT NOT NULL,
    "lcProvider" TEXT NOT NULL, "baseUrl" TEXT NOT NULL, "credentialEnvId" TEXT,
    "credentialCipher" TEXT, "authHeader" BOOLEAN NOT NULL DEFAULT true, "modelsJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // @ts-expect-error -- .mjs 无 d.ts（纯 JS 迁移脚本）
    const mod = (await import('../scripts/lib/incremental-schema.mjs')) as { runIncrementalSchema(db: Database.Database): void }
      const cases = ENDPOINT_PRESETS.map((p, i) => ({
        id: `row-${i}`,
        baseUrl: p.baseUrl,
        lc: p.protocol === 'anthropic-messages' ? 'anthropic' : 'openai',
        want: p.id,
      }))
      const ins = db.prepare(
        `INSERT INTO model_providers ("id", "ownerId", "providerId", "lcProvider", "baseUrl", "modelsJson") VALUES (?, 'u', ?, ?, ?, '[]')`,
      )
      for (const c of cases) ins.run(c.id, `pid-${c.id}`, c.lc, c.baseUrl)
      mod.runIncrementalSchema(db)
      for (const c of cases) {
        const row = db.prepare(`SELECT presetId FROM model_providers WHERE id=?`).get(c.id) as { presetId: string }
        expect(row?.presetId, `${c.baseUrl} → ${c.want}`).toBe(c.want)
      }
    } finally {
      db.close()
    }
  })

  it('同主机异协议行与保留 id 抢注行逐行 warn（按未知 host 同处理：丢弃不迁移）', async () => {
    const dbPath = path.join(makeDir(), 'panel.db')
    makeV15Db(dbPath)

    const warns: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(' '))
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // @ts-expect-error -- .mjs 无 d.ts（纯 JS 迁移脚本）
    const mod = (await import('../scripts/lib/incremental-schema.mjs')) as { runIncrementalSchema(db: Database.Database): void }
    const db = new Database(dbPath)
    try {
      mod.runIncrementalSchema(db)
    } finally {
      db.close()
    }

    const proto = warns.filter((w) => w.includes('mm-openai-face'))
    expect(proto).toHaveLength(1)
    expect(proto[0]).toContain('同主机异协议')
    expect(proto[0]).toContain('lcProvider=openai')
    const squat = warns.filter((w) => w.includes('squat-platform'))
    expect(squat).toHaveLength(1)
    expect(squat[0]).toContain("保留 id 'platform'")
  })

  it('copy-rebuild 原子性：插入失败整段回滚——旧 v15 表完好，修复后重跑可自愈', async () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
CREATE TABLE "users" ("id" TEXT NOT NULL PRIMARY KEY, "username" TEXT NOT NULL);
INSERT INTO "users" ("id", "username") VALUES ('u', 'u');
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
INSERT INTO "model_providers" ("id", "ownerId", "providerId", "lcProvider", "baseUrl", "modelsJson")
VALUES ('ghost-owner', 'u-ghost', 'p1', 'openai', 'https://api.openai.com/v1', '[]');
`)
      db.pragma('foreign_keys = ON') // 生产默认 OFF；此处开启以注入新表 FK 违例（ownerId 无 users 行）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // @ts-expect-error -- .mjs 无 d.ts（纯 JS 迁移脚本）
      const mod = (await import('../scripts/lib/incremental-schema.mjs')) as {
        runV16EndpointConvergence(db: Database.Database): void
      }
      expect(() => mod.runV16EndpointConvergence(db)).toThrow(/FOREIGN KEY/)
      // 回滚成功：v15 旧表形状与数据完好（非「空新表」或「表消失」中间态）——重跑可修复
      const cols = (db.prepare('PRAGMA table_info(model_providers)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(cols).toContain('baseUrl')
      expect((db.prepare('SELECT COUNT(*) n FROM model_providers').get() as { n: number }).n).toBe(1)
    } finally {
      db.close()
    }
  })
})
