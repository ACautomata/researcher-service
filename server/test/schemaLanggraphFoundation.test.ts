// #771 [#747·01] Prisma 新表地基 —— 数据模型契约 + 迁移幂等验收（纯逻辑单测；#771 票定
// 验收接缝 S1–S4 之 S3「纯逻辑单测」）。
//
// 验收依据（逐字段对齐）：
//   - #747 B 节表（sessions/session_messages/checkpoints/checkpoint_writes/memory_items/
//     tool_approval_logs/provider_endpoints/config_meta/plugin_enablements/attachments/file_journal
//     + users 加列 + model_providers 改造列）
//   - 731 §3 逐字段 DDL（provider_endpoints / model_providers 新形状 / users 加列 / config_meta
//     + §3.1 seed：迁移脚本写入 https://api.minimaxi.com 白名单条目）
//   - 729 §4.1（tool_approval_logs Prisma DDL 原文）
//   - 752 §4.2（plugin_enablements SQL 原文）
//   - 766 D1/D8 + 768 D7（attachments 九字段 / file_journal 行形状 / fork 复制不改 id → 复合主键）
//   - 770（sessions.archivedAt 软删除存档）
//
// 四类用例：
//   1) 字段契约 —— init.sql 落 fresh 库后逐表 PRAGMA table_info 断言（存在性/类型/NOT NULL/默认值）
//      + 唯一索引/复合主键断言（对齐上游 DDL，不测 Prisma 实现细节而测落库形状）。
//   2) 迁移幂等 —— apply-schema.mjs 对同一库连跑两次均退出 0 且 schema 一致；upgrade-schema.mjs
//      对「旧形状库」（users 无新列 + 旧 model_providers + pairings）增量收敛：新表就位、
//      users 列补齐、旧表形状原样不动（#771 验收「旧表不动，留待 T0 清退」）。
//      NEW_TABLE_COLUMNS 常量对 fresh（init.sql）与 upgrade（镜像脚本）两路径跑同一套逐字段
//      断言 —— 镜像与 init.sql 漂移即测试红（双写镜像的 parity 保险）。
//   3) 写入时序 —— attachments.messageId 可空 + 投影回填（766 D5/D9：附件行先于消息行）。
//   4) 级联行为 —— 删 session 行级联清 messages/checkpoints/checkpoint_writes/attachments/
//      file_journal（B 节 retention：删会话级联删）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { runDbScript } from './runDbScript'

const INIT_SQL = readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8')

interface ColInfo {
  name: string
  type: string
  notnull: number
  dflt_value: unknown
  pk: number
}

// 列期望：type/notnull 必断；dflt 给了才断（SQLite PRAGMA 把默认值回读为文本）。
interface ColExpect {
  type: string
  notnull: number
  dflt?: string
}

// PRAGMA table_info → 以列名为键的 map（缺失列断言更清晰的失败信息）
function colsOf(db: Database.Database, table: string): Map<string, ColInfo> {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as ColInfo[]
  return new Map(rows.map((c) => [c.name, c]))
}

function expectColumns(cols: Map<string, ColInfo>, expected: Record<string, ColExpect>): void {
  for (const [name, want] of Object.entries(expected)) {
    const c = cols.get(name)
    expect(c, `列 ${name} 存在`).toBeDefined()
    expect(c!.type, `列 ${name} 类型`).toBe(want.type)
    expect(c!.notnull, `列 ${name} NOT NULL`).toBe(want.notnull)
    if (want.dflt !== undefined) expect(String(c!.dflt_value), `列 ${name} 默认值`).toBe(want.dflt)
  }
}

// 复合主键成员断言（pk 序位非 0）
function expectPkMembers(cols: Map<string, ColInfo>, names: string[]): void {
  for (const name of names) {
    expect(cols.get(name)!.pk, `${name} 属复合主键`).toBeGreaterThan(0)
  }
}

function foreignKeysOf(db: Database.Database, table: string): Array<{ from: string; table: string; on_delete: string }> {
  return db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{ from: string; table: string; on_delete: string }>
}

function indexesOf(db: Database.Database, table: string): Array<{ name: string; unique: number }> {
  return db.prepare(`PRAGMA index_list("${table}")`).all() as Array<{ name: string; unique: number }>
}

// ---------------------------------------------------------------------------
// 逐字段期望常量 —— fresh（init.sql）与 upgrade（incremental 镜像）两路径共用（parity 锁）。
// ---------------------------------------------------------------------------

const USERS_NEW_COLUMNS: Record<string, ColExpect> = {
  maxConcurrentRuns: { type: 'INTEGER', notnull: 1, dflt: '2' }, // 731 §3.3
  approvalMode: { type: 'TEXT', notnull: 1, dflt: "'standard'" }, // 729 §3.5 谨慎模式
}

const MODEL_PROVIDER_NEW_COLUMNS: Record<string, ColExpect> = {
  // 731 §3.2 逐字段 DDL（归属上移新形状）
  id: { type: 'TEXT', notnull: 1 },
  ownerId: { type: 'TEXT', notnull: 1 },
  providerId: { type: 'TEXT', notnull: 1 },
  lcProvider: { type: 'TEXT', notnull: 1 },
  baseUrl: { type: 'TEXT', notnull: 1 },
  credentialEnvId: { type: 'TEXT', notnull: 0 }, // 过渡期可空
  credentialCipher: { type: 'TEXT', notnull: 0 }, // P1 per-user key 预留
  authHeader: { type: 'BOOLEAN', notnull: 1, dflt: 'true' },
  modelsJson: { type: 'TEXT', notnull: 1 },
  createdAt: { type: 'DATETIME', notnull: 1 },
}

const NEW_TABLE_COLUMNS: Record<string, Record<string, ColExpect>> = {
  sessions: {
    // #747 B 节 + #727：id = thread_id；containerId 无 FK（沙箱注册表归 #784）
    id: { type: 'TEXT', notnull: 1 },
    ownerId: { type: 'TEXT', notnull: 1 },
    containerId: { type: 'TEXT', notnull: 1 },
    title: { type: 'TEXT', notnull: 1 },
    parentSessionKey: { type: 'TEXT', notnull: 0 }, // fork 溯源
    forkSourceJson: { type: 'TEXT', notnull: 0 },
    activeCheckpointId: { type: 'TEXT', notnull: 0 }, // rewind/分支指针
    archivedAt: { type: 'DATETIME', notnull: 0 }, // #770 软删除存档
  },
  session_messages: {
    // B 节 + #727：产品读源，attachmentsJson v1 版本化聚合
    sessionId: { type: 'TEXT', notnull: 1 },
    turn: { type: 'INTEGER', notnull: 1 },
    role: { type: 'TEXT', notnull: 1 },
    content: { type: 'TEXT', notnull: 1 },
    attachmentsJson: { type: 'TEXT', notnull: 1, dflt: `'{"v":1}'` }, // schema 版本化（#726/#768）
    anchorCheckpointId: { type: 'TEXT', notnull: 0 },
  },
  checkpoints: {
    // #727 机制数据（LangGraph 五方法 saver 落点）
    threadId: { type: 'TEXT', notnull: 1 },
    checkpointNs: { type: 'TEXT', notnull: 1 },
    checkpointId: { type: 'TEXT', notnull: 1 },
    parentCheckpointId: { type: 'TEXT', notnull: 0 },
    type: { type: 'TEXT', notnull: 1 },
    blob: { type: 'BLOB', notnull: 1 }, // dumpsTyped 字节
    metadataJson: { type: 'TEXT', notnull: 1 },
  },
  checkpoint_writes: {
    threadId: { type: 'TEXT', notnull: 1 },
    checkpointNs: { type: 'TEXT', notnull: 1 },
    checkpointId: { type: 'TEXT', notnull: 1 },
    taskId: { type: 'TEXT', notnull: 1 },
    idx: { type: 'INTEGER', notnull: 1 },
    channel: { type: 'TEXT', notnull: 1 },
    type: { type: 'TEXT', notnull: 1 },
    blob: { type: 'BLOB', notnull: 1 },
  },
  memory_items: {
    // #727 BaseStore V1：namespace per-user 前缀，无 user FK（不级联）
    namespace: { type: 'TEXT', notnull: 1 },
    key: { type: 'TEXT', notnull: 1 },
    valueJson: { type: 'TEXT', notnull: 1 },
    // #774 补：BaseStore Item.createdAt 契约必填（首写时刻，put 覆盖不刷新）
    createdAt: { type: 'DATETIME', notnull: 1 },
    updatedAt: { type: 'DATETIME', notnull: 1 },
  },
  tool_approval_logs: {
    // 729 §4.1 原文（judge 输入存 hash 不存全文；userId 冗余无 FK）
    id: { type: 'TEXT', notnull: 1 },
    traceId: { type: 'TEXT', notnull: 1 },
    runId: { type: 'TEXT', notnull: 1 },
    userId: { type: 'TEXT', notnull: 1 },
    layer: { type: 'TEXT', notnull: 1 },
    decision: { type: 'TEXT', notnull: 1 },
    toolName: { type: 'TEXT', notnull: 1 },
    toolCall: { type: 'TEXT', notnull: 1 },
    policyClass: { type: 'TEXT', notnull: 0 },
    reason: { type: 'TEXT', notnull: 0 },
    judgeInputHash: { type: 'TEXT', notnull: 0 },
    latencyMs: { type: 'INTEGER', notnull: 0 },
    judgeTokens: { type: 'INTEGER', notnull: 0 },
  },
  provider_endpoints: {
    // 731 §3.1 原文（port NULL = 默认端口；origin 精确匹配唯一）
    id: { type: 'TEXT', notnull: 1 },
    scheme: { type: 'TEXT', notnull: 1 },
    host: { type: 'TEXT', notnull: 1 },
    port: { type: 'INTEGER', notnull: 0 },
    note: { type: 'TEXT', notnull: 1, dflt: "''" },
    createdBy: { type: 'TEXT', notnull: 1 }, // users.id（731 DDL 无 FK 约束 → 不加）
  },
  config_meta: {
    id: { type: 'INTEGER', notnull: 1 },
    version: { type: 'INTEGER', notnull: 1, dflt: '1' },
  },
  plugin_enablements: {
    // 752 §4.2 原文（复合主键 ownerId+pluginId；enabledAt 无默认）
    ownerId: { type: 'TEXT', notnull: 1 },
    pluginId: { type: 'TEXT', notnull: 1 },
    enabled: { type: 'BOOLEAN', notnull: 1, dflt: 'true' }, // 752 原文 INTEGER DEFAULT 1；BOOLEAN true 同值
    enabledAt: { type: 'DATETIME', notnull: 1 },
  },
  attachments: {
    // 766 D1 九字段（id/ownerId/sessionId/messageId/fileName/mimeType/size/sha256/path）；
    // fork 复制不改 attachmentId（768 D7）→ 复合主键 (sessionId, id)；
    // messageId 可空（766 D5 时序：上传建行先于消息行，投影时回填——G 节 D5/D9 两路径）
    sessionId: { type: 'TEXT', notnull: 1 },
    id: { type: 'TEXT', notnull: 1 }, // attachmentId 雪花算法（String 承载）
    ownerId: { type: 'TEXT', notnull: 1 },
    messageId: { type: 'TEXT', notnull: 0 },
    fileName: { type: 'TEXT', notnull: 1 },
    mimeType: { type: 'TEXT', notnull: 1 },
    size: { type: 'INTEGER', notnull: 1 }, // ≤100MB（D6），int32 内
    sha256: { type: 'TEXT', notnull: 1 },
    path: { type: 'TEXT', notnull: 1 }, // /lab/uploads/<attachmentId>/<原始文件名>
  },
  file_journal: {
    // 766 D8 行形状（checkpointId 锚点 + 全局 seq + op/path/前后 sha256 + tombstoneKey
    // + toolCallId 幂等键 + applied 标记）
    sessionId: { type: 'TEXT', notnull: 1 },
    checkpointId: { type: 'TEXT', notnull: 1 },
    seq: { type: 'INTEGER', notnull: 1 },
    op: { type: 'TEXT', notnull: 1 },
    path: { type: 'TEXT', notnull: 1 },
    beforeSha256: { type: 'TEXT', notnull: 0 },
    afterSha256: { type: 'TEXT', notnull: 0 },
    tombstoneKey: { type: 'TEXT', notnull: 0 },
    toolCallId: { type: 'TEXT', notnull: 1 },
    applied: { type: 'BOOLEAN', notnull: 1, dflt: 'false' },
  },
  llm_usage_records: {
    // #775（#747 F 节 / story 57）：一次 LLM 调用一行 usage_metadata 落账；runId/sessionId
    // 弱关联无 FK（审计行跟 user 永久，对齐 ToolApprovalLog 纪律）；用量四列 NOT NULL DEFAULT 0
    runId: { type: 'TEXT', notnull: 1 },
    sessionId: { type: 'TEXT', notnull: 0 },
    userId: { type: 'TEXT', notnull: 1 },
    username: { type: 'TEXT', notnull: 1 },
    providerId: { type: 'TEXT', notnull: 1 },
    lcProvider: { type: 'TEXT', notnull: 1 },
    model: { type: 'TEXT', notnull: 1 },
    inputTokens: { type: 'INTEGER', notnull: 1, dflt: '0' },
    outputTokens: { type: 'INTEGER', notnull: 1, dflt: '0' },
    cacheReadTokens: { type: 'INTEGER', notnull: 1, dflt: '0' },
    cacheWriteTokens: { type: 'INTEGER', notnull: 1, dflt: '0' },
  },
}

// 各表级 createdAt 公共列（fresh 与 upgrade 两路径都断言；checkpoint_writes 属 LangGraph
// 上游形状，无 createdAt —— 不带入）
const HAS_CREATED_AT = new Set([
  'sessions',
  'session_messages',
  'checkpoints',
  'tool_approval_logs',
  'provider_endpoints',
  'llm_usage_records',
])

describe('#771 Prisma 新表地基（字段契约 / 迁移幂等 / 级联）', () => {
  let dir: string
  let dbPath: string
  let sqlite: Database.Database

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), `panel-771-${process.pid}-`))
    dbPath = path.join(dir, 'contract.db')
    sqlite = new Database(dbPath)
    sqlite.exec(INIT_SQL)
  })
  afterAll(() => {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // 1) 字段契约 —— users 加列（731 §3.3 / 729 §3.5）
  // -------------------------------------------------------------------------
  describe('users 加列', () => {
    it('maxConcurrentRuns / approvalMode 逐字段对齐', () => {
      expectColumns(colsOf(sqlite, 'users'), USERS_NEW_COLUMNS)
    })
  })

  // -------------------------------------------------------------------------
  // 2) 字段契约 —— model_providers 改造形状（731 §3.2 逐字段 DDL）
  //    归属 containerId→ownerId 上移；lcProvider 二值白名单；credentialEnvId 过渡 +
  //    credentialCipher 预留；旧 api/apiKeyEnvId 列不复存在（形状改造，遗留表 T0 清退）
  // -------------------------------------------------------------------------
  describe('model_providers 改造形状（731 §3.2）', () => {
    it('列集逐字段对齐', () => {
      expectColumns(colsOf(sqlite, 'model_providers'), MODEL_PROVIDER_NEW_COLUMNS)
      // 旧形状列不复存在（改造而非并存）
      const cols = colsOf(sqlite, 'model_providers')
      expect(cols.has('containerId')).toBe(false)
      expect(cols.has('api')).toBe(false)
      expect(cols.has('apiKeyEnvId')).toBe(false)
    })

    it('唯一 (ownerId, providerId) + ownerId 外键级联 users（归属上移）', () => {
      const idx = indexesOf(sqlite, 'model_providers').find((i) => i.name === 'model_providers_ownerId_providerId_key')
      expect(idx).toBeDefined()
      expect(idx!.unique).toBe(1)
      const ownerFk = foreignKeysOf(sqlite, 'model_providers').find((f) => f.from === 'ownerId')
      expect(ownerFk).toBeDefined()
      expect(ownerFk!.table).toBe('users')
      expect(ownerFk!.on_delete).toBe('CASCADE')
    })
  })

  // -------------------------------------------------------------------------
  // 3) 字段契约 —— 新表逐字段（NEW_TABLE_COLUMNS 常量；唯一索引/复合主键/级联 FK 为各表特有断言）
  // -------------------------------------------------------------------------
  describe('新表逐字段对齐（fresh 路径，init.sql）', () => {
    it('sessions：列集 + ownerId 级联', () => {
      expectColumns(colsOf(sqlite, 'sessions'), NEW_TABLE_COLUMNS.sessions)
      const ownerFk = foreignKeysOf(sqlite, 'sessions').find((f) => f.from === 'ownerId')
      expect(ownerFk?.table).toBe('users')
      expect(ownerFk?.on_delete).toBe('CASCADE')
    })

    it('session_messages：attachmentsJson v1 默认值', () => {
      expectColumns(colsOf(sqlite, 'session_messages'), NEW_TABLE_COLUMNS.session_messages)
    })

    it('checkpoints：复合主键 (threadId, checkpointNs, checkpointId)', () => {
      expectColumns(colsOf(sqlite, 'checkpoints'), NEW_TABLE_COLUMNS.checkpoints)
      expectPkMembers(colsOf(sqlite, 'checkpoints'), ['threadId', 'checkpointNs', 'checkpointId'])
    })

    it('checkpoint_writes：复合主键 (threadId, checkpointNs, checkpointId, taskId, idx)', () => {
      expectColumns(colsOf(sqlite, 'checkpoint_writes'), NEW_TABLE_COLUMNS.checkpoint_writes)
      expectPkMembers(colsOf(sqlite, 'checkpoint_writes'), ['threadId', 'checkpointNs', 'checkpointId', 'taskId', 'idx'])
    })

    it('checkpoints / checkpoint_writes：threadId 均级联 sessions（删会话级联清机制数据 —— B 节 retention）', () => {
      for (const table of ['checkpoints', 'checkpoint_writes']) {
        const fk = foreignKeysOf(sqlite, table).find((f) => f.from === 'threadId')
        expect(fk, `${table}.threadId FK`).toBeDefined()
        expect(fk!.table).toBe('sessions')
        expect(fk!.on_delete).toBe('CASCADE')
      }
    })

    it('memory_items：复合主键 (namespace, key)；无 user FK（跟 user 不级联）', () => {
      expectColumns(colsOf(sqlite, 'memory_items'), NEW_TABLE_COLUMNS.memory_items)
      expectPkMembers(colsOf(sqlite, 'memory_items'), ['namespace', 'key'])
      expect(foreignKeysOf(sqlite, 'memory_items')).toEqual([])
    })

    it('tool_approval_logs：userId 冗余无 FK（729 §4.1 原文）', () => {
      expectColumns(colsOf(sqlite, 'tool_approval_logs'), NEW_TABLE_COLUMNS.tool_approval_logs)
      expect(foreignKeysOf(sqlite, 'tool_approval_logs')).toEqual([])
    })

    it('provider_endpoints：唯一 (scheme, host, port) —— origin 精确匹配（731 §3.1）', () => {
      expectColumns(colsOf(sqlite, 'provider_endpoints'), NEW_TABLE_COLUMNS.provider_endpoints)
      const idx = indexesOf(sqlite, 'provider_endpoints').find(
        (i) => i.name === 'provider_endpoints_scheme_host_port_key',
      )
      expect(idx).toBeDefined()
      expect(idx!.unique).toBe(1)
    })

    it('config_meta：id INTEGER PK + version DEFAULT 1（单行计数器）', () => {
      expectColumns(colsOf(sqlite, 'config_meta'), NEW_TABLE_COLUMNS.config_meta)
      expect(colsOf(sqlite, 'config_meta').get('id')).toMatchObject({ pk: 1 })
    })

    it('plugin_enablements：复合主键 (ownerId, pluginId) + ownerId 级联 users（752 §4.2）', () => {
      expectColumns(colsOf(sqlite, 'plugin_enablements'), NEW_TABLE_COLUMNS.plugin_enablements)
      expectPkMembers(colsOf(sqlite, 'plugin_enablements'), ['ownerId', 'pluginId'])
      const fk = foreignKeysOf(sqlite, 'plugin_enablements').find((f) => f.from === 'ownerId')
      expect(fk?.table).toBe('users')
      expect(fk?.on_delete).toBe('CASCADE') // 面板 user 行级联先例（752 草图未钉级联语义）
    })

    it('attachments：复合主键 (sessionId, id)（768 D7 fork 复制不改 attachmentId）', () => {
      expectColumns(colsOf(sqlite, 'attachments'), NEW_TABLE_COLUMNS.attachments)
      expectPkMembers(colsOf(sqlite, 'attachments'), ['sessionId', 'id'])
    })

    it('attachments：sessionId/ownerId/messageId 三级联（删会话级联删 —— 766 D7）', () => {
      const fks = foreignKeysOf(sqlite, 'attachments')
      expect(fks.find((f) => f.from === 'sessionId')).toMatchObject({ table: 'sessions', on_delete: 'CASCADE' })
      expect(fks.find((f) => f.from === 'ownerId')).toMatchObject({ table: 'users', on_delete: 'CASCADE' })
      expect(fks.find((f) => f.from === 'messageId')).toMatchObject({ table: 'session_messages', on_delete: 'CASCADE' })
    })

    it('file_journal：唯一 (sessionId, seq) 与 (sessionId, toolCallId)（D7 fork 复制 → 唯一域收窄会话级）', () => {
      expectColumns(colsOf(sqlite, 'file_journal'), NEW_TABLE_COLUMNS.file_journal)
      // id 内部代理主键（cuid）—— fork 复制行后仍逐行可寻址
      expect(colsOf(sqlite, 'file_journal').get('id')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 1 })
      const idxs = indexesOf(sqlite, 'file_journal')
      expect(idxs.find((i) => i.name === 'file_journal_sessionId_seq_key')?.unique).toBe(1)
      expect(idxs.find((i) => i.name === 'file_journal_sessionId_toolCallId_key')?.unique).toBe(1)
      const fk = foreignKeysOf(sqlite, 'file_journal').find((f) => f.from === 'sessionId')
      expect(fk?.table).toBe('sessions')
      expect(fk?.on_delete).toBe('CASCADE')
    })

    it('机制/配置表带 createdAt 公共列（DATETIME NOT NULL）', () => {
      for (const table of HAS_CREATED_AT) {
        const c = colsOf(sqlite, table).get('createdAt')
        expect(c, `${table}.createdAt`).toMatchObject({ type: 'DATETIME', notnull: 1 })
      }
    })

    it('llm_usage_records：核算索引三枚（userId+createdAt / model+createdAt / runId per-run 对账 #812）', () => {
      expectColumns(colsOf(sqlite, 'llm_usage_records'), NEW_TABLE_COLUMNS.llm_usage_records)
      const idxs = indexesOf(sqlite, 'llm_usage_records')
      expect(idxs.find((i) => i.name === 'llm_usage_records_userId_createdAt_idx')).toBeDefined()
      expect(idxs.find((i) => i.name === 'llm_usage_records_model_createdAt_idx')).toBeDefined()
      expect(idxs.find((i) => i.name === 'llm_usage_records_runId_idx')).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // 4) 迁移幂等 —— apply-schema 对同一库连跑两次（#771 验收「幂等可重跑」）
  // -------------------------------------------------------------------------
  describe('迁移幂等', () => {
    it('apply-schema.mjs 对空库连跑两次均退出 0，schema 一致 + 种子幂等', () => {
      const p = path.join(dir, 'idempotent-apply.db')
      runDbScript('apply-schema.mjs', p) // 首次：full init.sql + 增量收敛
      const probe = (file: string) => {
        const d = new Database(file, { readonly: true })
        const tables = (
          d.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>
        ).map((r) => r.name)
        const usersCols = colsOf(d, 'users')
        const meta = d.prepare(`SELECT id, version FROM config_meta`).get() as { id: number; version: number }
        const endpoint = d
          .prepare(`SELECT id, scheme, host, port, createdBy FROM provider_endpoints`)
          .get() as { id: string; scheme: string; host: string; port: null; createdBy: string }
        const endpointCount = (d.prepare(`SELECT count(*) c FROM provider_endpoints`).get() as { c: number }).c
        d.close()
        return { tables, hasRuns: usersCols.has('maxConcurrentRuns'), hasMode: usersCols.has('approvalMode'), meta, endpoint, endpointCount }
      }
      const first = probe(p)
      runDbScript('apply-schema.mjs', p) // 第二次：全部 skip-if-exists，仍须退出 0、种子不重复
      const second = probe(p)
      expect(second).toEqual(first)
      expect(first.tables).toEqual(
        expect.arrayContaining([
          'sessions', 'session_messages', 'checkpoints', 'checkpoint_writes', 'memory_items',
          'tool_approval_logs', 'provider_endpoints', 'config_meta', 'plugin_enablements',
          'attachments', 'file_journal',
        ]),
      )
      expect(first.hasRuns).toBe(true)
      expect(first.hasMode).toBe(true)
      expect(first.meta).toEqual({ id: 1, version: 1 })
      // 731 §3.1 seed：minimax 端点白名单条目就位；重跑不重复（幂等）
      expect(first.endpoint).toEqual({ id: 'seed-minimax-endpoint', scheme: 'https', host: 'api.minimaxi.com', port: null, createdBy: '' })
      expect(first.endpointCount).toBe(1)
    })

    it('upgrade-schema.mjs 对「旧形状库」增量收敛：新表就位 + users 列补齐 + 旧表形状不动（留待 T0 清退）', () => {
      const p = path.join(dir, 'legacy-upgrade.db')
      const d = new Database(p)
      // 造最小旧形状：users（无新列）+ 旧 model_providers（containerId/api/apiKeyEnvId）+ pairings
      d.exec(`
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "containers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "containers_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "model_providers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "containerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "api" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKeyEnvId" TEXT NOT NULL,
    "authHeader" BOOLEAN NOT NULL DEFAULT true,
    "modelsJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "model_providers_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "containers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "pairings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "containerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unpaired',
    "updatedAt" DATETIME NOT NULL
);
`)
      d.close()
      runDbScript('upgrade-schema.mjs', p)
      runDbScript('upgrade-schema.mjs', p) // 可重跑

      const d2 = new Database(p, { readonly: true })
      const tables = (
        d2.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>
      ).map((r) => r.name)
      for (const t of Object.keys(NEW_TABLE_COLUMNS)) {
        expect(tables, `新表 ${t} 就位`).toContain(t)
      }
      // users 加列补齐
      expectColumns(colsOf(d2, 'users'), USERS_NEW_COLUMNS)
      // 新表逐字段：与 fresh 路径同一套期望（镜像漂移即红 —— parity 保险）
      for (const [table, expected] of Object.entries(NEW_TABLE_COLUMNS)) {
        expectColumns(colsOf(d2, table), expected)
      }
      for (const table of HAS_CREATED_AT) {
        const c = colsOf(d2, table).get('createdAt')
        expect(c, `upgrade 路径 ${table}.createdAt`).toMatchObject({ type: 'DATETIME', notnull: 1 })
      }
      // 旧形状 model_providers 原样不动（containerId/api/apiKeyEnvId 仍在；新 ownerId/lcProvider 不加）
      const mpCols = colsOf(d2, 'model_providers')
      expect(mpCols.has('containerId')).toBe(true)
      expect(mpCols.has('api')).toBe(true)
      expect(mpCols.has('apiKeyEnvId')).toBe(true)
      expect(mpCols.has('ownerId')).toBe(false)
      expect(mpCols.has('lcProvider')).toBe(false)
      // pairings 不动
      expect(colsOf(d2, 'pairings').has('deviceId')).toBe(false)
      // config_meta 种子 + 731 §3.1 白名单 seed（重跑不重复）
      expect(d2.prepare(`SELECT id, version FROM config_meta`).get()).toEqual({ id: 1, version: 1 })
      expect(
        (d2.prepare(`SELECT count(*) c FROM provider_endpoints WHERE id='seed-minimax-endpoint'`).get() as { c: number }).c,
      ).toBe(1)
      // #812：runId 索引随增量收敛就位（per-run 对账下钻，三处同源的镜像侧）
      expect(indexesOf(d2, 'llm_usage_records').find((i) => i.name === 'llm_usage_records_runId_idx')).toBeDefined()
      d2.close()
    })

    // #774 回归：#771 形状库（memory_items 已建表但无 createdAt 列——#771 地基遗漏）经
    // upgrade 补列 + 回填。pre-#771 旧形状用例（上方）因 CREATE IF NOT EXISTS 先建带列新表
    // 走不到 ALTER 分支，真实 #771→#774 升级形状仅此用例覆盖（code-review 阻断项回归）。
    it('upgrade-schema.mjs 对「#771 形状库」（memory_items 已建但无 createdAt 列）补列 + 回填旧行', () => {
      const p = path.join(dir, 'memory-items-createdat-upgrade.db')
      const d = new Database(p)
      // 造 #771 形状：memory_items 无 createdAt 列 + 一行存量数据
      d.exec(`
CREATE TABLE "memory_items" (
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueJson" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("namespace", "key")
);
INSERT INTO "memory_items" ("namespace", "key", "valueJson", "updatedAt")
VALUES ('user-a', 'legacy-note', '{"v":1}', '2026-09-30 12:00:00');
`)
      d.close()
      runDbScript('upgrade-schema.mjs', p)
      runDbScript('upgrade-schema.mjs', p) // 可重跑

      const d2 = new Database(p, { readonly: true })
      // 补列与 fresh 路径同一套逐字段期望（NOT NULL 语义不破，parity 保持）
      expectColumns(colsOf(d2, 'memory_items'), NEW_TABLE_COLUMNS.memory_items)
      // 旧行回填：占位常量被 CURRENT_TIMESTAMP 覆盖（真实成形时刻不可考，取迁移时刻）
      const row = d2
        .prepare(
          `SELECT "createdAt" FROM "memory_items" WHERE "namespace"='user-a' AND "key"='legacy-note'`,
        )
        .get() as { createdAt: string }
      expect(row.createdAt).not.toBe('1970-01-01 00:00:00')
      d2.close()
    })

    // #818 CD 崩溃回归：#778 之前的镜像（≤#777 部署）已建出**无 clientKey** 的 session_messages
    // ——增量收敛必须「先补列、后建 (sessionId, clientKey) 唯一索引」，否则索引引用缺失列，
    // `no such column: "clientKey"` 令 entrypoint 崩溃循环、health gate 永不过（6f19ebf 与
    // d4b1e2d 两次 CD 失败的生产实锤）。pre-#778 形状因 CREATE IF NOT EXISTS 先建带列新表
    // 走不到 ALTER 分支，真实部署形状仅此用例覆盖（memory_items createdAt 回归同款纪律）。
    it('upgrade-schema.mjs 对「#778 前形状库」（session_messages 已建但无 clientKey）补列 + 唯一索引就位', () => {
      const p = path.join(dir, 'session-messages-clientkey-upgrade.db')
      const d = new Database(p)
      // 造 #778 前形状：session_messages 无 clientKey 列 + 一行存量数据（旧行 clientKey 恒 null）
      d.exec(`
CREATE TABLE "session_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "turn" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "attachmentsJson" TEXT NOT NULL DEFAULT '{"v":1}',
    "anchorCheckpointId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "session_messages" ("id", "sessionId", "turn", "role")
VALUES ('m1', 's1', 0, 'user');
`)
      d.close()
      runDbScript('upgrade-schema.mjs', p)
      runDbScript('upgrade-schema.mjs', p) // 可重跑

      const d2 = new Database(p, { readonly: true })
      // 补列：nullable TEXT（旧行保持 null——SQLite 唯一索引 NULL 互相不等价，不撞约束）
      const ck = colsOf(d2, 'session_messages').get('clientKey')
      expect(ck, 'clientKey 列存在').toBeDefined()
      expect(ck!.type).toBe('TEXT')
      expect(ck!.notnull).toBe(0)
      // 唯一索引就位（guard 之后创建；崩溃场景即此语句先于补列执行）
      expect(
        indexesOf(d2, 'session_messages').find((i) => i.name === 'session_messages_sessionId_clientKey_key'),
      ).toBeDefined()
      // 存量行原样保留
      expect(
        d2.prepare(`SELECT "id", "clientKey" FROM "session_messages" WHERE "id"='m1'`).get(),
      ).toEqual({ id: 'm1', clientKey: null })
      d2.close()
    })

    it('apply-schema.mjs 对「旧形状库」可重跑：跳过 model_providers 新索引不崩溃 + 新表照常 + 旧表不动', () => {
      const p = path.join(dir, 'legacy-apply.db')
      const d = new Database(p)
      // 旧库夹具：users 逐列对齐 master init.sql（无新列、含 email 等索引列）；model_providers
      // 省略 containerId→containers FK（判别列 containerId 在场即复现崩溃场景，FK 无涉）
      d.exec(`
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
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE TABLE "model_providers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "containerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "api" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKeyEnvId" TEXT NOT NULL,
    "authHeader" BOOLEAN NOT NULL DEFAULT true,
    "modelsJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`)
      d.close()
      runDbScript('apply-schema.mjs', p) // 修复前：此处撞 CREATE UNIQUE INDEX (ownerId, providerId) 崩溃
      runDbScript('apply-schema.mjs', p) // 可重跑

      const d2 = new Database(p, { readonly: true })
      const tables = (
        d2.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>
      ).map((r) => r.name)
      for (const t of Object.keys(NEW_TABLE_COLUMNS)) {
        expect(tables, `新表 ${t} 就位`).toContain(t)
      }
      expectColumns(colsOf(d2, 'users'), USERS_NEW_COLUMNS) // users 加列经增量收敛补齐
      // 旧 model_providers 形状原样：无 ownerId 列、新唯一索引未建
      const mpCols = colsOf(d2, 'model_providers')
      expect(mpCols.has('containerId')).toBe(true)
      expect(mpCols.has('ownerId')).toBe(false)
      expect(indexesOf(d2, 'model_providers').find((i) => i.name === 'model_providers_ownerId_providerId_key')).toBeUndefined()
      d2.close()
    })
  })

  // -------------------------------------------------------------------------
  // 5) 写入时序 —— attachments.messageId 可空 + 投影回填（766 D5/D9：附件行先于消息行）
  // -------------------------------------------------------------------------
  describe('attachments 写入时序（766 D5/D9）', () => {
    it('messageId 可空：上传建行先于消息行，投影时回填', async () => {
      const p = path.join(dir, 'attach-null-message.db')
      runDbScript('apply-schema.mjs', p)
      const prisma = createPrismaClient(`file:${p}`) as PrismaClient
      try {
        const user = await prisma.user.create({ data: { username: 'att1' } })
        const session = await prisma.session.create({
          data: { id: 'thread-att1', ownerId: user.id, containerId: 'researcher-sandbox-thread-att1', title: '' },
        })
        // D5 上传路径：元数据行先于任何消息行落库
        await prisma.attachment.create({
          data: {
            sessionId: session.id,
            id: '1900000000000000101',
            ownerId: user.id,
            fileName: 'up.png',
            mimeType: 'image/png',
            size: 3,
            sha256: '2'.repeat(64),
            path: '/lab/uploads/1900000000000000101/up.png',
          },
        })
        // 投影时回填 messageId
        const msg = await prisma.sessionMessage.create({
          data: { sessionId: session.id, turn: 1, role: 'user', content: 'see file' },
        })
        await prisma.attachment.update({
          where: { sessionId_id: { sessionId: session.id, id: '1900000000000000101' } },
          data: { messageId: msg.id },
        })
        expect(await prisma.attachment.count({ where: { messageId: msg.id } })).toBe(1)
      } finally {
        await prisma.$disconnect()
      }
    })
  })

  // -------------------------------------------------------------------------
  // 6) 级联行为 —— 删会话级联清（B 节 retention；Prisma client 走真实落库路径验证）
  // -------------------------------------------------------------------------
  describe('级联行为（删会话级联清）', () => {
    it('删 session → messages/checkpoints/writes/attachments/file_journal 级联清；user 保留', async () => {
      const p = path.join(dir, 'cascade.db')
      runDbScript('apply-schema.mjs', p)
      const prisma = createPrismaClient(`file:${p}`) as PrismaClient
      try {
        const user = await prisma.user.create({
          data: { username: 'cas1', maxConcurrentRuns: 2, approvalMode: 'standard' },
        })
        const session = await prisma.session.create({
          data: { id: 'thread-cas1', ownerId: user.id, containerId: 'researcher-sandbox-thread-cas1', title: '' },
        })
        const msg = await prisma.sessionMessage.create({
          data: { sessionId: session.id, turn: 1, role: 'user', content: 'hi' },
        })
        await prisma.checkpoint.create({
          data: {
            threadId: session.id,
            checkpointNs: '',
            checkpointId: 'cp-1',
            type: 'json',
            blob: new Uint8Array([1, 2, 3]),
            metadataJson: '{}',
          },
        })
        await prisma.checkpointWrite.create({
          data: {
            threadId: session.id,
            checkpointNs: '',
            checkpointId: 'cp-1',
            taskId: 'task-1',
            idx: 0,
            channel: 'messages',
            type: 'json',
            blob: new Uint8Array([4]),
          },
        })
        await prisma.attachment.create({
          data: {
            sessionId: session.id,
            id: '1900000000000000001',
            ownerId: user.id,
            messageId: msg.id,
            fileName: 'a.png',
            mimeType: 'image/png',
            size: 3,
            sha256: '0'.repeat(64),
            path: '/lab/uploads/1900000000000000001/a.png',
          },
        })
        await prisma.fileJournal.create({
          data: {
            sessionId: session.id,
            checkpointId: 'cp-1',
            seq: 1,
            op: 'write',
            path: 'lab/x.txt',
            afterSha256: '1'.repeat(64),
            toolCallId: 'call-1',
          },
        })

        await prisma.session.delete({ where: { id: session.id } })

        expect(await prisma.sessionMessage.count()).toBe(0)
        expect(await prisma.checkpoint.count()).toBe(0)
        expect(await prisma.checkpointWrite.count()).toBe(0)
        expect(await prisma.attachment.count()).toBe(0)
        expect(await prisma.fileJournal.count()).toBe(0)
        expect(await prisma.user.count()).toBe(1) // user 保留（memory/审计跟 user 不级联）
      } finally {
        await prisma.$disconnect()
      }
    })
  })
})
