-- #1078 · RF-T02：历史读取变更版本触发器（与 init.sql 同源维护，非 prisma generate 产物）。
-- 语义：破坏既有历史读取边界的 mutation 与业务写入同事务递增 per-session 版本；
-- 普通消息追加（archivedAt IS NULL 的 INSERT）与标题/模型设置不递增，续读因此不失效。
-- 消费方：sessions/history/sqliteReader（专用只读连接）；测试基座与 db:apply 均执行本文件。

CREATE TRIGGER IF NOT EXISTS "session_messages_history_version_update"
AFTER UPDATE ON "session_messages"
BEGIN
  INSERT INTO "session_history_versions" ("sessionId", "version", "updatedAt")
  VALUES (OLD."sessionId", 1, CURRENT_TIMESTAMP)
  ON CONFLICT("sessionId") DO UPDATE SET "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER IF NOT EXISTS "session_messages_history_version_delete"
AFTER DELETE ON "session_messages"
WHEN EXISTS (SELECT 1 FROM "sessions" WHERE "id" = OLD."sessionId")
BEGIN
  INSERT INTO "session_history_versions" ("sessionId", "version", "updatedAt")
  VALUES (OLD."sessionId", 1, CURRENT_TIMESTAMP)
  ON CONFLICT("sessionId") DO UPDATE SET "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP;
END;

-- 失败残留清理等路径可能补写已归档行；归档可见性自写入即生效。
CREATE TRIGGER IF NOT EXISTS "session_messages_history_version_archived_insert"
AFTER INSERT ON "session_messages"
WHEN NEW."archivedAt" IS NOT NULL
BEGIN
  INSERT INTO "session_history_versions" ("sessionId", "version", "updatedAt")
  VALUES (NEW."sessionId", 1, CURRENT_TIMESTAMP)
  ON CONFLICT("sessionId") DO UPDATE SET "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER IF NOT EXISTS "sessions_history_version_visibility"
AFTER UPDATE ON "sessions"
WHEN OLD."archivedAt" IS NOT NEW."archivedAt" OR OLD."isTeammate" IS NOT NEW."isTeammate"
BEGIN
  INSERT INTO "session_history_versions" ("sessionId", "version", "updatedAt")
  VALUES (NEW."id", 1, CURRENT_TIMESTAMP)
  ON CONFLICT("sessionId") DO UPDATE SET "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP;
END;

-- 会话删除后清理版本行；版本表无外键，避免级联删除时版本触发器写已删会话报错。
CREATE TRIGGER IF NOT EXISTS "sessions_history_version_delete"
AFTER DELETE ON "sessions"
BEGIN
  DELETE FROM "session_history_versions" WHERE "sessionId" = OLD."id";
END;
