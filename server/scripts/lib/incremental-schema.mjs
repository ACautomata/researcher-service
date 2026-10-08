// 增量 SQLite schema 收敛 —— apply-schema.mjs（初始化后收敛）与 upgrade-schema.mjs
// （entrypoint 每次启动调用）共享本过程，保证两条路径对同一 DB 收敛到同一形状。
//
// 铁律（#771 验收）：
//   - 全程幂等可重跑 —— CREATE 系 IF NOT EXISTS；ADD COLUMN 经 PRAGMA table_info guard
//     （SQLite 无 ADD COLUMN IF NOT EXISTS）；种子 INSERT OR IGNORE。
//   - 默认只做 additive；显式非 additive 例外 = 换轨 DROP 重建（#791 figures 先例 / T0 #801
//     legacy 清退：旧形状 model_providers DROP、pairings DROP / #858 OpenClaw 退役③：containers
//     表 DROP）——均依 #732 零迁移前提（产品未上线，旧行不迁移直接换轨）。
//   - DDL 与 prisma/init.sql 逐字节同源（镜像其 CREATE 形状），init.sql 由
//     prisma migrate diff 从 schema.prisma 派生 —— 单一来源，此处镜像。
// 版本史：7→8 #771 langgraph foundation；8→9 #775 usage 表 + minimax seed；9→10 #787；
// 10→11 #786 isTeammate；11→12 #785 file_overwrite_logs；12→13 #790 teammates.kind +
// #791 figures 换轨；13→14 T0 #801 legacy 清退；14→15 #858 OpenClaw 退役③（containers 表 DROP）。
export const SCHEMA_VERSION = 15

export function runIncrementalSchema(db) {
  const hasSessions = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get()
  if (hasSessions && !db.prepare('PRAGMA table_info("sessions")').all().some(c => c.name === 'preferredModelJson')) {
    db.exec('ALTER TABLE "sessions" ADD COLUMN "preferredModelJson" TEXT')
  }
  // #782（#747·12）：sessions 水位列（files rewind 的 planRevert 判定下界——scope=chat 保持
  // 现状永久化面）。ADD COLUMN 非幂等，PRAGMA guard 先查再补（对齐 preferredModelJson 模式）。
  if (hasSessions && !db.prepare('PRAGMA table_info("sessions")').all().some(c => c.name === 'fileJournalAnchorSeq')) {
    db.exec('ALTER TABLE "sessions" ADD COLUMN "fileJournalAnchorSeq" INTEGER')
  }
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
    "svg" TEXT,
    "png" BLOB,
    "evaluation" TEXT,
    "sessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "figures_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
`)

  // #791（#747·21 · #744 v2 §5/§8）：AutoFigure 数据模型换轨 —— GenerationJob 退役 + Figure
  // 改造（xml→svg 列改名落为重建、idempotencyKey/唯一索引退役、sessionId 溯源列新增）。
  // 零迁移前提（#732：产品未上线，旧 Figure 行不迁移、旧产物不转换，直接换轨删除）→ 旧形状
  // figures 检测到即 DROP 重建新形状（「空库直建」语义的迁移化表达，#744 §5.1）；执行状态机
  // 归会话 run 域（#744 §5.2），generation_jobs 无条件 DROP。全程幂等：
  //   - 旧形状判定 = 有 sessionId 且无 xml 且无 idempotencyKey 之外的一切情况（含表不存在）
  //   - DROP 重建后二跑：新形状命中跳过；DROP IF EXISTS 对不存在表 no-op
  // 本段必须先于下方 figures_ownerId_idx 索引创建（#818 教训：guard/重建先于索引——DROP 连带
  // 旧索引消失，索引在其后重建才不落空）。
  const figCols791 = db.prepare(`PRAGMA table_info("figures")`).all()
  const figFresh791 =
    figCols791.length > 0 &&
    figCols791.some((c) => c.name === 'sessionId') &&
    !figCols791.some((c) => c.name === 'xml') &&
    !figCols791.some((c) => c.name === 'idempotencyKey')
  if (!figFresh791) {
    if (figCols791.length > 0) {
      db.exec('DROP TABLE "figures"')
    }
    db.exec(`
CREATE TABLE IF NOT EXISTS "figures" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "svg" TEXT,
    "png" BLOB,
    "evaluation" TEXT,
    "sessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "figures_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
`)
  }
  db.exec('DROP TABLE IF EXISTS "generation_jobs"')
  db.exec(`CREATE INDEX IF NOT EXISTS "figures_ownerId_idx" ON "figures"("ownerId")`)

  // ---- T0 #801 legacy 清退（先 DROP 后 CREATE：本段须在 model_providers 新形状 CREATE
  // 与 minimax seed 之前执行）----
  runFleetRetirement(db)
  runT0LegacyCleanup(db)

  runLanggraphFoundation(db)
}

// #858 OpenClaw 退役③：containers 表（openclaw-gw fleet 容器记账行）整表 DROP。
// 容器 CRUD REST/管理页随本票退役，wiki/models/files 归属门前置票（#856/#857）已解绑容器行；
// 消费面清零后零迁移前提换轨（#732：旧行不迁移直接删）。幂等：DROP IF EXISTS 对不存在表
// no-op（索引 containers_name_key / containers_ownerId_idx 随表连带消失）。
export function runFleetRetirement(db) {
  db.exec('DROP TABLE IF EXISTS "containers"')
}

// T0 #801 legacy 清退：旧形状 model_providers / pairings 处置。
// 零迁移前提（#732：产品未上线，旧行不迁移直接换轨）：检测到旧形状 model_providers
//（containerId/api/apiKeyEnvId 列）即 DROP（新形状 CREATE 由 runLanggraphFoundation 紧随，
// minimax seed 随之补默认 provider）；pairings 表（设备配对全链退役）一并幂等清退。
// （原 containers 升级编排列/port 唯一索引处置随 #858 整表 DROP 收编进 runFleetRetirement。）
// 全程可重跑：DROP IF EXISTS / PRAGMA guard。
export function runT0LegacyCleanup(db) {
  const mpTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='model_providers'`).get()
  const mpLegacy =
    !!mpTable &&
    db.prepare(`PRAGMA table_info("model_providers")`).all().some((c) => c.name === 'containerId')
  if (mpTable && mpLegacy) {
    // eslint-disable-next-line no-console
    console.warn('[db:schema] T0 #801：检测到旧形状 model_providers（containerId/api/apiKeyEnvId）——DROP（零迁移前提，旧行不迁移），新形状 CREATE 与默认 seed 紧随')
    db.exec('DROP TABLE "model_providers"')
  }
  db.exec(`DROP TABLE IF EXISTS "pairings"`)
}

// #771（#747·01）Prisma 新表地基：#747 B 节全表 + users 加列 + model_providers 新形状
//（旧形状由 runT0LegacyCleanup 先 DROP，此处 CREATE IF NOT EXISTS 重建）。
// DDL 镜像 prisma/init.sql（schema.prisma 派生）同形状，全 IF NOT EXISTS。
function runLanggraphFoundation(db) {
  // ---- users 加列（731 §3.3 / 729 §3.5）——既有库表已存在，ADD COLUMN 经 PRAGMA guard ----
  const usersTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`).get()
  if (usersTable) {
    const userCols = db.prepare(`PRAGMA table_info("users")`).all()
    if (!userCols.some((c) => c.name === 'maxConcurrentRuns')) {
      db.exec(`ALTER TABLE "users" ADD COLUMN "maxConcurrentRuns" INTEGER NOT NULL DEFAULT 2`)
    }
    if (!userCols.some((c) => c.name === 'approvalMode')) {
      db.exec(`ALTER TABLE "users" ADD COLUMN "approvalMode" TEXT NOT NULL DEFAULT 'standard'`)
    }
  }

  // ---- model_providers 新形状（#771 归属上移；旧形状 DROP 归 runT0LegacyCleanup 先行）----
  db.exec(`
CREATE TABLE IF NOT EXISTS "model_providers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "lcProvider" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "credentialEnvId" TEXT,
    "credentialCipher" TEXT,
    "authHeader" BOOLEAN NOT NULL DEFAULT true,
    "modelsJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "model_providers_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "model_providers_ownerId_providerId_key" ON "model_providers"("ownerId", "providerId");
`)

  // ---- 会话历史域新表（#747 B 节 / #727）----
  db.exec(`
CREATE TABLE IF NOT EXISTS "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "parentSessionKey" TEXT,
    "forkSourceJson" TEXT,
    "activeCheckpointId" TEXT,
    "preferredModelJson" TEXT,
    "fileJournalAnchorSeq" INTEGER,
    "archivedAt" DATETIME,
    "isTeammate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "sessions_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "teammates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "parentSessionId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "kind" TEXT NOT NULL DEFAULT 'generic',
    "modelProviderId" TEXT,
    "spawnedAtCheckpointId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME,
    CONSTRAINT "teammates_parentSessionId_fkey" FOREIGN KEY ("parentSessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "teammates_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "teammate_mailbox_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "parentSessionId" TEXT NOT NULL,
    "senderTeammateId" TEXT,
    "recipientTeammateId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'message',
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME,
    "invalidatedAt" DATETIME,
    "expiresAt" DATETIME,
    CONSTRAINT "teammate_mailbox_messages_parentSessionId_fkey" FOREIGN KEY ("parentSessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "teammate_mailbox_messages_senderTeammateId_fkey" FOREIGN KEY ("senderTeammateId") REFERENCES "teammates" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "teammate_mailbox_waits" (
    "waitId" TEXT NOT NULL PRIMARY KEY,
    "parentSessionId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL UNIQUE,
    "recipientTeammateId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "teammate_mailbox_waits_parentSessionId_fkey" FOREIGN KEY ("parentSessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "teammate_mailbox_waits_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "teammate_mailbox_waits_recipientTeammateId_fkey" FOREIGN KEY ("recipientTeammateId") REFERENCES "teammates" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "session_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "turn" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "clientKey" TEXT,
    "attachmentsJson" TEXT NOT NULL DEFAULT '{"v":1}',
    "anchorCheckpointId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "session_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "checkpoints" (
    "threadId" TEXT NOT NULL,
    "checkpointNs" TEXT NOT NULL DEFAULT '',
    "checkpointId" TEXT NOT NULL,
    "parentCheckpointId" TEXT,
    "type" TEXT NOT NULL,
    "blob" BLOB NOT NULL,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("threadId", "checkpointNs", "checkpointId"),
    CONSTRAINT "checkpoints_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "checkpoint_writes" (
    "threadId" TEXT NOT NULL,
    "checkpointNs" TEXT NOT NULL DEFAULT '',
    "checkpointId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "blob" BLOB NOT NULL,

    PRIMARY KEY ("threadId", "checkpointNs", "checkpointId", "taskId", "idx"),
    CONSTRAINT "checkpoint_writes_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "memory_items" (
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("namespace", "key")
);

CREATE TABLE IF NOT EXISTS "tool_approval_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "traceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolCall" TEXT NOT NULL,
    "policyClass" TEXT,
    "reason" TEXT,
    "judgeInputHash" TEXT,
    "latencyMs" INTEGER,
    "judgeTokens" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "attachments" (
    "sessionId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "messageId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "path" TEXT NOT NULL,

    PRIMARY KEY ("sessionId", "id"),
    CONSTRAINT "attachments_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "attachments_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "session_messages" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "file_journal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "checkpointId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "op" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "beforeSha256" TEXT,
    "afterSha256" TEXT,
    "tombstoneKey" TEXT,
    "toolCallId" TEXT NOT NULL,
    "runId" TEXT,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "fileRevertedAt" DATETIME,
    "archivedAt" DATETIME,
    CONSTRAINT "file_journal_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
`)

  // #782（#747·12）：file_journal 生命周期三列（runId = 终态回填键；fileRevertedAt = 逆放
  // 处置标；archivedAt = 被放弃路线软删）。镜像部署早于本票的库已建出无列表——CREATE IF NOT
  // EXISTS 对既有表 no-op，PRAGMA guard 先查再补（对齐 T02/T03 模式）。fresh 库（上方
  // CREATE TABLE 已带列）→ guard 跳过。**guard 必须先于下方索引创建**（#778 clientKey 同型
  // 坑，#818 CD 崩溃回归生产实锤）。
  const hasFileJournal = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_journal'").get()
  if (hasFileJournal) {
    const fjCols = db.prepare('PRAGMA table_info("file_journal")').all()
    if (!fjCols.some((c) => c.name === 'runId')) {
      db.exec('ALTER TABLE "file_journal" ADD COLUMN "runId" TEXT')
    }
    if (!fjCols.some((c) => c.name === 'fileRevertedAt')) {
      db.exec('ALTER TABLE "file_journal" ADD COLUMN "fileRevertedAt" DATETIME')
    }
    if (!fjCols.some((c) => c.name === 'archivedAt')) {
      db.exec('ALTER TABLE "file_journal" ADD COLUMN "archivedAt" DATETIME')
    }
  }

  db.exec(`
CREATE INDEX IF NOT EXISTS "file_journal_sessionId_checkpointId_idx" ON "file_journal"("sessionId", "checkpointId");
CREATE UNIQUE INDEX IF NOT EXISTS "file_journal_sessionId_seq_key" ON "file_journal"("sessionId", "seq");
CREATE UNIQUE INDEX IF NOT EXISTS "file_journal_sessionId_toolCallId_key" ON "file_journal"("sessionId", "toolCallId");
`)

  // #786 teammate thread flags: existing session rows default to leader; teammate threads are hidden
  // from the user's session list while remaining valid LangGraph checkpoint threads.
  const sessionsTable = db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'sessions')
  if (sessionsTable) {
    const sessionCols = db.prepare('PRAGMA table_info("sessions")').all()
    if (!sessionCols.some((c) => c.name === 'isTeammate')) {
      db.exec('ALTER TABLE "sessions" ADD COLUMN "isTeammate" BOOLEAN NOT NULL DEFAULT false')
    }
  }

  // #790（#747·20 · G 节三通道②）teammates 补 kind 列（generic 缺省 / wiki-update = 治理生成
  // teammate——RunService 据此装配落地副本 backend + 生命周期工具；拓扑可由持久化状态推导）。
  // ADD COLUMN 非幂等，PRAGMA guard 先查再补（对齐 isTeammate 模式）。fresh 库（上方 CREATE
  // TABLE 已带列）此处列存在 → guard 跳过。
  const teammatesTable = db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'teammates')
  if (teammatesTable) {
    const teammateCols = db.prepare('PRAGMA table_info("teammates")').all()
    if (!teammateCols.some((c) => c.name === 'kind')) {
      db.exec(`ALTER TABLE "teammates" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'generic'`)
    }
  }

  // #778（#747·08 · story 7）：session_messages 补 clientKey 列（32-hex 幂等 key，仅 user 行
  // 携带）——(sessionId, clientKey) 唯一索引 = 断网重发不重复入列的约束面。ADD COLUMN 非幂等，
  // PRAGMA guard 先查再补（对齐 T02 模式）。fresh 库（上方 CREATE TABLE 已带列）此处列存在
  // → guard 跳过。
  //
  // **guard 必须先于下方索引创建**（#818 CD 崩溃回归，生产实锤）：#778 之前的镜像（≤#777
  // 部署）已在此建出**无 clientKey** 的 session_messages——CREATE IF NOT EXISTS 对既有表
  // no-op，若 (sessionId, clientKey) 唯一索引先于补列执行，`no such column: "clientKey"`
  // 令 entrypoint 崩溃循环、health gate 永不过。故 guard 独立于索引块之前：既有库先 ALTER
  // 再建索引，fresh 库两分支自然正确（索引块全部语句只引用 CREATE TABLE 自带列 + 本 guard
  // 补的列）。
  const smCols = db.prepare(`PRAGMA table_info("session_messages")`).all()
  if (smCols.length > 0 && !smCols.some((c) => c.name === 'clientKey')) {
    db.exec(`ALTER TABLE "session_messages" ADD COLUMN "clientKey" TEXT`)
  }

  // #781（#747·11 · #770 rewind 软删）：session_messages / checkpoints / file_journal 三表
  // 补 archivedAt 软删列——被放弃原路线行打标记（投影过滤/逆放跳过/GC 回收对象），行不物理删。
  // ADD COLUMN 非幂等，PRAGMA guard 先查再补（三处 nullable，无回填需求）。
  if (smCols.length > 0 && !smCols.some((c) => c.name === 'archivedAt')) {
    db.exec(`ALTER TABLE "session_messages" ADD COLUMN "archivedAt" DATETIME`)
  }
  const cpCols = db.prepare(`PRAGMA table_info("checkpoints")`).all()
  if (cpCols.length > 0 && !cpCols.some((c) => c.name === 'archivedAt')) {
    db.exec(`ALTER TABLE "checkpoints" ADD COLUMN "archivedAt" DATETIME`)
  }
  const fjCols = db.prepare(`PRAGMA table_info("file_journal")`).all()
  if (fjCols.length > 0 && !fjCols.some((c) => c.name === 'archivedAt')) {
    db.exec(`ALTER TABLE "file_journal" ADD COLUMN "archivedAt" DATETIME`)
  }

  // ---- B 节索引（在全部 B 节表 + 补列 guard 之后统一创建；IF NOT EXISTS 幂等）----
  db.exec(`
CREATE INDEX IF NOT EXISTS "sessions_ownerId_idx" ON "sessions"("ownerId");
CREATE UNIQUE INDEX IF NOT EXISTS "teammates_threadId_key" ON "teammates"("threadId");
CREATE UNIQUE INDEX IF NOT EXISTS "teammates_parentSessionId_name_key" ON "teammates"("parentSessionId", "name");
CREATE INDEX IF NOT EXISTS "teammates_parentSessionId_status_idx" ON "teammates"("parentSessionId", "status");
CREATE INDEX IF NOT EXISTS "teammate_mailbox_messages_parentSessionId_recipientTeammateId_createdAt_idx" ON "teammate_mailbox_messages"("parentSessionId", "recipientTeammateId", "createdAt");
CREATE INDEX IF NOT EXISTS "teammate_mailbox_messages_recipientTeammateId_readAt_invalidatedAt_idx" ON "teammate_mailbox_messages"("recipientTeammateId", "readAt", "invalidatedAt");
CREATE INDEX IF NOT EXISTS "teammate_mailbox_waits_parentSessionId_recipientTeammateId_idx" ON "teammate_mailbox_waits"("parentSessionId", "recipientTeammateId");
CREATE INDEX IF NOT EXISTS "session_messages_sessionId_turn_idx" ON "session_messages"("sessionId", "turn");
CREATE UNIQUE INDEX IF NOT EXISTS "session_messages_sessionId_clientKey_key" ON "session_messages"("sessionId", "clientKey");
CREATE INDEX IF NOT EXISTS "checkpoints_threadId_checkpointNs_idx" ON "checkpoints"("threadId", "checkpointNs");
CREATE INDEX IF NOT EXISTS "checkpoint_writes_threadId_checkpointNs_idx" ON "checkpoint_writes"("threadId", "checkpointNs");
CREATE INDEX IF NOT EXISTS "tool_approval_logs_traceId_idx" ON "tool_approval_logs"("traceId");
CREATE INDEX IF NOT EXISTS "tool_approval_logs_userId_createdAt_idx" ON "tool_approval_logs"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "attachments_ownerId_idx" ON "attachments"("ownerId");
CREATE INDEX IF NOT EXISTS "attachments_sessionId_idx" ON "attachments"("sessionId");
CREATE INDEX IF NOT EXISTS "file_journal_sessionId_checkpointId_idx" ON "file_journal"("sessionId", "checkpointId");
CREATE UNIQUE INDEX IF NOT EXISTS "file_journal_sessionId_seq_key" ON "file_journal"("sessionId", "seq");
CREATE UNIQUE INDEX IF NOT EXISTS "file_journal_sessionId_toolCallId_key" ON "file_journal"("sessionId", "toolCallId");
`)

  // ---- 配置域新表（731 §3：provider_endpoints / config_meta · 752 §4.2：plugin_enablements）----
  db.exec(`
CREATE TABLE IF NOT EXISTS "provider_endpoints" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scheme" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "config_meta" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS "plugin_enablements" (
    "ownerId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "enabledAt" DATETIME NOT NULL,

    PRIMARY KEY ("ownerId", "pluginId"),
    CONSTRAINT "plugin_enablements_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "provider_endpoints_scheme_host_port_key" ON "provider_endpoints"("scheme", "host", "port");
`)

  // #774（#747·04）：memory_items 补 createdAt 列（BaseStore Item 契约必填，#771 地基遗漏）。
  // ADD COLUMN 非天然幂等，PRAGMA guard 先查再补。注意默认值处理不适用 T02/T03/T06 先例——
  // 那几处全为 nullable 或常量默认，而 SQLite 禁 ADD COLUMN 非常量默认值（CURRENT_TIMESTAMP
  // 仅 CREATE TABLE 可用）+ NOT NULL 必须有非 NULL 默认，故占位常量 + UPDATE 回填：guard 块内
  // 列刚加，全部既有行该列必为占位值，无条件回填安全（记忆成形时刻不可考，取迁移时刻——
  // 本票前无生产消费者，无脏数据）。占位 DEFAULT 残留列定义无害：Prisma client 对
  // @default(now()) 在 INSERT 显式传值，不触发表级 default。
  // fresh 库（上方 CREATE TABLE 已带列）此处列存在 → guard 跳过。
  const miCols = db.prepare(`PRAGMA table_info("memory_items")`).all()
  if (!miCols.some((c) => c.name === 'createdAt')) {
    db.exec(
      `ALTER TABLE "memory_items" ADD COLUMN "createdAt" DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00'`,
    )
    db.exec(`UPDATE "memory_items" SET "createdAt" = CURRENT_TIMESTAMP`)
  }

  // config_meta 单行种子（id=1, version=1）：INSERT OR IGNORE 幂等；provider/endpoint CRUD
  // 同事务 +1（热生效信号，731 §4）自 version=1 起步。fresh 库（init.sql CREATE 空表）同样
  // 经此路径补种子，与既有库一致。
  db.exec(`INSERT OR IGNORE INTO "config_meta" ("id", "version") VALUES (1, 1)`)

  // 731 §3.1 seed：迁移脚本把默认 minimax 种子端点写入白名单（原 openclaw.json 模板默认语义——
  // 模板与 ConfigRenderer 已随 T0 #801 退役，seed 名单内联于此）。createdBy 无用户语境（面板级 seed，
  // users 表可能为空）→ ''（该列无 FK，不伪造 users.id）；幂等 = 固定 seed id + INSERT OR
  // IGNORE——#775 迁移存量用户 minimax provider 行时遇已存在条目自然跳过。
  db.exec(`
INSERT OR IGNORE INTO "provider_endpoints" ("id", "scheme", "host", "port", "note", "createdBy", "createdAt")
VALUES ('seed-minimax-endpoint', 'https', 'api.minimaxi.com', NULL,
        'seed（731 §3.1）：默认 minimax 端点', '', CURRENT_TIMESTAMP)
`)

  // ---- #785（#747·15 · #769 锁方案）：file_overwrite_logs（write-after-write 覆盖审计）----
  // 取锁写 path 时存在已 applied 且上家 writer ≠ 本 thread 的 file_journal 行 → 记一次
  // （path/覆盖者/被覆盖者，不限时窗）。弱关联无 FK（审计快照纪律）；D8「观测面进审计域」。
  db.exec(`
CREATE TABLE IF NOT EXISTS "file_overwrite_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "overwriterThreadId" TEXT NOT NULL,
    "overwrittenThreadId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "file_overwrite_logs_sessionId_path_idx" ON "file_overwrite_logs"("sessionId", "path");
CREATE INDEX IF NOT EXISTS "file_overwrite_logs_createdAt_idx" ON "file_overwrite_logs"("createdAt");
`)

  // ---- 旧形状 model_providers 检测段已迁出至 runT0LegacyCleanup（先 DROP 后 CREATE 次序）----

  // ---- #775（#747 F 节）：llm_usage_records（usage 全量采数，story 57 成本核算数据源）----
  db.exec(`
CREATE TABLE IF NOT EXISTS "llm_usage_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "lcProvider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "llm_usage_records_userId_createdAt_idx" ON "llm_usage_records"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "llm_usage_records_model_createdAt_idx" ON "llm_usage_records"("model", "createdAt");
CREATE INDEX IF NOT EXISTS "llm_usage_records_runId_idx" ON "llm_usage_records"("runId");
`)

  // ---- #775 minimax 默认 provider seed（731 §6 逐字段映射末行：「空 providers → 模板默认」
  // 的显式 seed 化）——每存量用户（当前零 provider 行）一行 minimax，幂等三保险：
  //   ① NOT EXISTS（用户已有任意 provider 行——新形状表 (ownerId, providerId) 唯一键构造上
  //     已无同 owner 重复行，「归属按 ownerId 折叠去重」在本表范围内即此语义）→ 跳过
  //   ② 确定性 seed id（'seed-mp-minimax-' || userId，重跑 INSERT OR IGNORE 命中同主键）
  //   ③ unique(ownerId, providerId) 兜底
  // T0 #801：旧形状表已在上方 DROP 重建（新形状 CREATE 段见 #771 段），seed 对全量用户生效。
  // 漂移守卫 = providerDefaults.test.ts 双向锁定（本处内联 JSON ↔ runner/providerDefaults.ts
  // 常量；deploy/openclaw.json 模板已随 T0 删除）。
  // 守卫：users 表存在才 seed——极旧/残缺部署（如仅 text_trace 批次的最小库）无用户可 seed。
  const usersTable801 = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`).get()
  if (usersTable801) {
    db.exec(`
INSERT OR IGNORE INTO "model_providers"
  ("id", "ownerId", "providerId", "lcProvider", "baseUrl", "credentialEnvId", "authHeader", "modelsJson", "createdAt")
SELECT 'seed-mp-minimax-' || u."id", u."id", 'minimax', 'anthropic',
       'https://api.minimaxi.com/anthropic', 'LLM_API_KEY', 1,
       '[{"id":"MiniMax-M3","name":"MiniMax M3","reasoning":true,"input":["text","image"],"cost":{"input":0.3,"output":1.2,"cacheRead":0.06,"cacheWrite":0.375},"contextWindow":1048576,"maxTokens":524288}]',
       CURRENT_TIMESTAMP
FROM "users" u
WHERE NOT EXISTS (SELECT 1 FROM "model_providers" mp WHERE mp."ownerId" = u."id")
`)
  }
}
