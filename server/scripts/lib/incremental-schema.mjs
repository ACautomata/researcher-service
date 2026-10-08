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
// #791 figures 换轨；13→14 T0 #801 legacy 清退；14→15 #858 OpenClaw 退役③（containers 表 DROP）；
// 15→16 #881 端点预设制收敛（model_providers copy-rebuild 归一 + provider_endpoints 表退役 +
// minimax 种子退役 + plugin_llm_assignments 备用表）。
export const SCHEMA_VERSION = 16

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
  runV16EndpointConvergence(db)
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

  // ---- model_providers v16 形状（#881 端点预设制：presetId 取代自由地址与旧凭证列）。
  // v15 形状旧表存在时本 CREATE 为 no-op——copy-rebuild 归 runV16EndpointConvergence（后置）。----
  db.exec(`
CREATE TABLE IF NOT EXISTS "model_providers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "presetId" TEXT NOT NULL,
    "credentialCipher" TEXT,
    "modelsJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "model_providers_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
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

  // ---- 配置域新表（731 §3：config_meta · 752 §4.2：plugin_enablements）。
  // provider_endpoints 白名单表随 #881 预设制退役（DROP 归 runV16EndpointConvergence）。----
  db.exec(`
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
}

// #881（schema 收敛段 v15→v16）端点预设制换轨。幂等可重跑：
//   ① model_providers copy-rebuild：v15 形状（有 baseUrl 列）→ 逐行 host+协议归一迁移到
//     v16 新形状（presetId 取代 lcProvider/baseUrl/credentialEnvId/authHeader——协议/地址/
//     凭证头策略改由预设派生；credentialCipher 统一 NULL = 平台共享 key）。归一规则：
//       - baseUrl host ∈ 预设 host 集 且 lcProvider 与该预设协议一致 → 归一（id/providerId/
//         modelsJson/createdAt 原样保留）；同 host 异协议行（白名单时代 MiniMax/DeepSeek 的
//         OpenAI 兼容面配置）迁移后运行时才炸（协议面不匹配）——按未知 host 同处理：
//         丢弃 + 逐行 console.warn
//       - seed-mp-minimax-* 种子行 → 跳过（种子退役：零 provider 用户改由虚拟平台条目服务）
//       - providerId='platform' 行（v16 前保留域校验缺失的存量抢注）→ 丢弃 + 逐行 warn
//         （与平台虚拟条目同 id 会遮蔽条目、默认链出现重复 providerId）
//       - 未知 host 行 → 丢弃 + 逐行 console.warn（预设域外自由地址不迁移，#732 零迁移前提）
//     全段单事务（DROP+CREATE+INSERT+引用 remap）：SQLite DDL 可回滚——插入失败/中途崩溃
//     旧表完好，重跑自愈（幂等铁律的隐含承诺）；分步 DROP+CREATE 在事务外 = 全表清零且
//     重跑探测不到 v15 形状的不可恢复窗口。
//   ①+ 退役 seed id 的存量引用 remap：/model 钉过 'minimax'（seed providerId）的会话偏好
//     （sessions.preferredModelJson）与 teammate 指派（teammates.modelProviderId）改指平台
//     虚拟条目（同形状兜底，下一 run 不断链）；该 owner 尚有自建 providerId='minimax' 行时
//     不动（引用仍有效）。teammates 无 ownerId 列——经 parentSessionId → sessions.ownerId
//     关联判自建行存在性。
//   ② provider_endpoints 端点白名单表整表退役（admin 白名单链随预设制退役；索引随表连带消失）。
//   ③ plugin_llm_assignments 备用表（per-user 插件 LLM 指派，消费者归 #883；'judge' 保留键行）。
//   ④ (ownerId, providerId) 唯一索引统一在此建（fresh 库 v16 表直建后同样命中）。
// host 归一映射与 src/models/presets.ts 预设清单同源——漂移守卫 providerMigration.test.ts
// （逐预设 host 造行跑收敛断言归一）+ modelsPresets.test.ts（PRESET_HOST_TO_ID 形状）双向锁定。
const V16_HOST_TO_PRESET = new Map([
  ['api.minimaxi.com', 'minimax'],
  ['api.anthropic.com', 'anthropic'],
  ['api.openai.com', 'openai'],
  ['api.deepseek.com', 'deepseek'],
  ['api.moonshot.cn', 'kimi'],
  ['open.bigmodel.cn', 'zhipu'],
])

// 预设 id → 期望 lcProvider 二值（与 presets.ts protocolToLcProvider 同规则内联——.mjs 不能
// import TS；同源性经 providerMigration.test.ts 逐预设双协议造行断言锁定）。
const V16_PRESET_LC = new Map([
  ['minimax', 'anthropic'],
  ['anthropic', 'anthropic'],
  ['openai', 'openai'],
  ['deepseek', 'openai'],
  ['kimi', 'openai'],
  ['zhipu', 'openai'],
])

export function runV16EndpointConvergence(db) {
  const mpTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='model_providers'`).get()
  const mpCols = mpTable ? db.prepare(`PRAGMA table_info("model_providers")`).all() : []
  const isV15 = mpCols.some((c) => c.name === 'baseUrl')
  if (isV15) {
    // copy-rebuild：读旧行（内存）→ 单事务内 DROP → 建新形状 → 逐行归一 INSERT（保留
    // id/createdAt）→ 引用 remap。事务外不残留任何中间态（DDL 回滚保旧表，重跑自愈）。
    // INSERT 语句须在事务内（新表 CREATE 之后）prepare——better-sqlite3 prepare 即按
    // 当前 schema 编译，语句在外层会按 v15 旧表编译直接炸「no column named presetId」。
    const legacyRows = db
      .prepare(`SELECT "id", "ownerId", "providerId", "lcProvider", "baseUrl", "modelsJson", "createdAt" FROM "model_providers" ORDER BY "createdAt", "id"`)
      .all()
    const rebuild = db.transaction(() => {
      db.exec(`DROP TABLE "model_providers"`)
      db.exec(`
CREATE TABLE IF NOT EXISTS "model_providers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "presetId" TEXT NOT NULL,
    "credentialCipher" TEXT,
    "modelsJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "model_providers_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
`)
      const insert = db.prepare(`
INSERT INTO "model_providers" ("id", "ownerId", "providerId", "presetId", "credentialCipher", "modelsJson", "createdAt")
VALUES (?, ?, ?, ?, NULL, ?, ?)
`)
      for (const row of legacyRows) {
        if (String(row.id).startsWith('seed-mp-minimax-')) continue // 种子退役（虚拟平台条目服务）
        if (String(row.providerId) === 'platform') {
          // eslint-disable-next-line no-console
          console.warn(`[db:schema] #881 v16 收敛：providerId 为保留 id 'platform'，行丢弃（不迁移）id=${row.id}`)
          continue
        }
        const host = hostOf(String(row.baseUrl))
        const presetId = host !== null ? V16_HOST_TO_PRESET.get(host) : undefined
        if (presetId === undefined) {
          // eslint-disable-next-line no-console
          console.warn(`[db:schema] #881 v16 收敛：未知端点 host，行丢弃（不迁移）id=${row.id} baseUrl=${row.baseUrl}`)
          continue
        }
        if (V16_PRESET_LC.get(presetId) !== String(row.lcProvider)) {
          // eslint-disable-next-line no-console
          console.warn(`[db:schema] #881 v16 收敛：同主机异协议（lcProvider=${row.lcProvider}，预设 ${presetId} 期望 ${V16_PRESET_LC.get(presetId)}），行丢弃（不迁移）id=${row.id} baseUrl=${row.baseUrl}`)
          continue
        }
        insert.run(row.id, row.ownerId, row.providerId, presetId, row.modelsJson, row.createdAt)
      }
      remapRetiredMinimaxRefs(db)
    })
    rebuild()
  }

  // ② 白名单表整表退役（含 seed-minimax-endpoint 等行；索引随表连带消失）
  db.exec(`DROP TABLE IF EXISTS "provider_endpoints"`)

  // ③ 插件 LLM 指派备用表（752 §5 V2 per-user 配置项提前建表；providerId NULL=跟随默认链 /
  // 'platform'=钉平台；modelId 须属端点模型集——约束在应用层，#883 落地）
  db.exec(`
CREATE TABLE IF NOT EXISTS "plugin_llm_assignments" (
    "ownerId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "providerId" TEXT,
    "modelId" TEXT,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("ownerId", "pluginId"),
    CONSTRAINT "plugin_llm_assignments_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
`)

  // ④ 唯一索引（copy-rebuild 后随新表重建；fresh 库幂等命中）
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "model_providers_ownerId_providerId_key" ON "model_providers"("ownerId", "providerId")`)
}

// baseUrl → host 小写（解析失败返回 null——归一路按未知 host 丢弃告警）。
function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return null
  }
}

// 退役 seed providerId 'minimax' 的存量引用 remap（#881 P2 修复）：/model 钉过 seed 行的
// 会话偏好 / teammate 指派改指平台虚拟条目（同形状兜底，下一 run 不断链——否则 resolveModelRef
// 40040、run 失败至用户手动重选）。该 owner 尚有自建 providerId='minimax' 行时不动（引用仍
// 有效）。列存在性经 PRAGMA 守卫（收敛段可能在列引入前的更老库形上跑——prepared 语句引用
// 缺失列即抛，守卫后跳过）。仅 copy-rebuild 事务内调用一次（v16 库重跑不进此段）。
function remapRetiredMinimaxRefs(db) {
  const sessCols = db.prepare(`PRAGMA table_info("sessions")`).all().map((c) => c.name)
  if (sessCols.includes('preferredModelJson')) {
    db.exec(`
UPDATE "sessions"
SET "preferredModelJson" = json_set("preferredModelJson", '$.providerId', 'platform')
WHERE json_valid("preferredModelJson")
  AND json_extract("preferredModelJson", '$.providerId') = 'minimax'
  AND NOT EXISTS (
    SELECT 1 FROM "model_providers" mp
    WHERE mp."providerId" = 'minimax' AND mp."ownerId" = "sessions"."ownerId"
  );
`)
  }
  const tmCols = db.prepare(`PRAGMA table_info("teammates")`).all().map((c) => c.name)
  if (tmCols.includes('modelProviderId')) {
    // teammates 无 ownerId 列：经 parentSessionId → sessions.ownerId 关联判自建行存在性。
    db.exec(`
UPDATE "teammates"
SET "modelProviderId" = 'platform'
WHERE "modelProviderId" = 'minimax'
  AND NOT EXISTS (
    SELECT 1 FROM "model_providers" mp
    WHERE mp."providerId" = 'minimax'
      AND mp."ownerId" = (SELECT s."ownerId" FROM "sessions" s WHERE s."id" = "teammates"."parentSessionId")
  );
`)
  }
}
