-- #1084 · RF-T08：来源变化 / 删除 / rewind 的反思证据失效触发器（非 prisma generate 产物）。
--
-- 语义：源消息内容变化、归档（rewind 放弃路线）或删除时，与源 mutation 同一 SQLite 事务把
-- 关联证据同步封锁（draft evidence not_ready / record evidence invalid / record review_required
-- / 未消费授权撤销 / 展示撤销），并把待清理摘录写入可靠 outbox。读门在事务返回前即看到封锁态；
-- outbox 清理只负责物理副本（正文/原因中逐字复制的来源文字），不承担一致性。
--
-- 普通追加（INSERT archivedAt IS NULL）不触发；files-only rewind 不动消息行，因此不影响纯对话证据。
-- 同一文件由 apply-schema / upgrade-schema / 测试基座共同执行（重建触发器幂等）。

-- #1083：重建旧触发器以升级到 revision 感知规则；组合根在接收请求前执行。
DROP TRIGGER IF EXISTS "session_messages_reflection_source_update";
DROP TRIGGER IF EXISTS "session_messages_reflection_source_delete";
DROP TRIGGER IF EXISTS "sessions_reflection_source_delete";
DROP TRIGGER IF EXISTS "sessions_reflection_source_visibility";

-- 源消息 UPDATE：内容变化 / 产品聚合变化 / 归档（rewind 放弃路线）。
CREATE TRIGGER IF NOT EXISTS "session_messages_reflection_source_update"
AFTER UPDATE ON "session_messages"
WHEN OLD."content" IS NOT NEW."content"
   OR OLD."attachmentsJson" IS NOT NEW."attachmentsJson"
   OR (OLD."archivedAt" IS NULL AND NEW."archivedAt" IS NOT NULL)
BEGIN
  INSERT INTO "reflection_cleanup_outbox"
    ("id", "ownerId", "sessionId", "messageId", "kind", "excerpt", "state", "attempts", "createdAt", "updatedAt")
  SELECT lower(hex(randomblob(16))), "ownerId", "sessionId", "messageId", 'source_cleanup', "excerpt", 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "reflection_evidence"
  WHERE "messageId" = NEW."id" AND "status" = 'valid';

  INSERT INTO "reflection_cleanup_outbox"
    ("id", "ownerId", "sessionId", "messageId", "kind", "excerpt", "state", "attempts", "createdAt", "updatedAt")
  SELECT lower(hex(randomblob(16))), "ownerId", "sessionId", "messageId", 'source_cleanup', "excerpt", 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "reflection_record_evidence"
  WHERE "messageId" = NEW."id" AND "status" = 'valid';

  UPDATE "reflection_evidence" SET "status" = 'not_ready', "reason" = 'source_changed'
  WHERE "messageId" = NEW."id" AND "status" = 'valid';

  UPDATE "reflection_record_evidence" SET "status" = 'invalid', "reason" = 'source_changed'
  WHERE "messageId" = NEW."id" AND "status" = 'valid';

  UPDATE "reflection_records" SET "evidenceStatus" = 'review_required'
  WHERE "evidenceStatus" = 'valid'
    AND "id" IN (SELECT "recordId" FROM "reflection_record_evidence" WHERE "messageId" = NEW."id" AND "status" = 'invalid' AND "recordId" = "reflection_records"."id" AND "recordVersion" = "reflection_records"."currentRevision");

  UPDATE "reflection_drafts" SET "status" = 'preparing'
  WHERE "status" IN ('pending', 'confirmed_pending_save')
    AND "id" IN (
      SELECT "e"."draftId" FROM "reflection_evidence" "e"
      WHERE "e"."messageId" = NEW."id" AND "e"."draftVersion" = "reflection_drafts"."version"
    );

  UPDATE "reflection_grants" SET "status" = 'revoked'
  WHERE "status" = 'active'
    AND EXISTS (SELECT 1 FROM "reflection_evidence" "e" WHERE "e"."messageId" = NEW."id" AND "e"."draftId" = "reflection_grants"."draftId" AND "e"."draftVersion" = "reflection_grants"."draftVersion");

  UPDATE "reflection_presentations" SET "status" = 'revoked', "revokedAt" = CURRENT_TIMESTAMP
  WHERE "status" IN ('active', 'acked')
    AND EXISTS (SELECT 1 FROM "reflection_evidence" "e" WHERE "e"."messageId" = NEW."id" AND "e"."draftId" = "reflection_presentations"."draftId" AND "e"."draftVersion" = "reflection_presentations"."draftVersion");
END;

-- 源消息 DELETE：recover 残留清理等直接删除路径（会话级联删除由 sessions 触发器 + 删除钩子兜底）。
CREATE TRIGGER IF NOT EXISTS "session_messages_reflection_source_delete"
AFTER DELETE ON "session_messages"
BEGIN
  INSERT INTO "reflection_cleanup_outbox"
    ("id", "ownerId", "sessionId", "messageId", "kind", "excerpt", "state", "attempts", "createdAt", "updatedAt")
  SELECT lower(hex(randomblob(16))), "ownerId", "sessionId", "messageId", 'source_cleanup', "excerpt", 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "reflection_evidence"
  WHERE "messageId" = OLD."id" AND "status" = 'valid';

  INSERT INTO "reflection_cleanup_outbox"
    ("id", "ownerId", "sessionId", "messageId", "kind", "excerpt", "state", "attempts", "createdAt", "updatedAt")
  SELECT lower(hex(randomblob(16))), "ownerId", "sessionId", "messageId", 'source_cleanup', "excerpt", 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "reflection_record_evidence"
  WHERE "messageId" = OLD."id" AND "status" = 'valid';

  UPDATE "reflection_evidence" SET "status" = 'not_ready', "reason" = 'source_deleted'
  WHERE "messageId" = OLD."id" AND "status" = 'valid';

  UPDATE "reflection_record_evidence" SET "status" = 'invalid', "reason" = 'source_deleted'
  WHERE "messageId" = OLD."id" AND "status" = 'valid';

  UPDATE "reflection_records" SET "evidenceStatus" = 'review_required'
  WHERE "evidenceStatus" = 'valid'
    AND "id" IN (SELECT "recordId" FROM "reflection_record_evidence" WHERE "messageId" = OLD."id" AND "status" = 'invalid' AND "recordId" = "reflection_records"."id" AND "recordVersion" = "reflection_records"."currentRevision");

  UPDATE "reflection_drafts" SET "status" = 'preparing'
  WHERE "status" IN ('pending', 'confirmed_pending_save')
    AND "id" IN (
      SELECT "e"."draftId" FROM "reflection_evidence" "e"
      WHERE "e"."messageId" = OLD."id" AND "e"."draftVersion" = "reflection_drafts"."version"
    );

  UPDATE "reflection_grants" SET "status" = 'revoked'
  WHERE "status" = 'active'
    AND EXISTS (SELECT 1 FROM "reflection_evidence" "e" WHERE "e"."messageId" = OLD."id" AND "e"."draftId" = "reflection_grants"."draftId" AND "e"."draftVersion" = "reflection_grants"."draftVersion");

  UPDATE "reflection_presentations" SET "status" = 'revoked', "revokedAt" = CURRENT_TIMESTAMP
  WHERE "status" IN ('active', 'acked')
    AND EXISTS (SELECT 1 FROM "reflection_evidence" "e" WHERE "e"."messageId" = OLD."id" AND "e"."draftId" = "reflection_presentations"."draftId" AND "e"."draftVersion" = "reflection_presentations"."draftVersion");
END;

-- 源会话删除：已提交结论独立保留（records 无会话外键），但证据/结论须退出主动使用。
-- 草稿/展示随 sessions 外键级联清理；未消费授权的撤销由 SessionService 删除事务显式钩子完成
--（跨会话确认的 grant 仍需在该事务里撤，触发器此时可能已随级联看不到草稿行）。
CREATE TRIGGER IF NOT EXISTS "sessions_reflection_source_delete"
AFTER DELETE ON "sessions"
BEGIN
  INSERT INTO "reflection_cleanup_outbox"
    ("id", "ownerId", "sessionId", "messageId", "kind", "excerpt", "state", "attempts", "createdAt", "updatedAt")
  SELECT lower(hex(randomblob(16))), "ownerId", "sessionId", "messageId", 'source_cleanup', "excerpt", 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "reflection_record_evidence"
  WHERE "sessionId" = OLD."id" AND "status" = 'valid';

  UPDATE "reflection_record_evidence" SET "status" = 'invalid', "reason" = 'source_deleted'
  WHERE "sessionId" = OLD."id" AND "status" = 'valid';

  UPDATE "reflection_records" SET "evidenceStatus" = 'review_required'
  WHERE "evidenceStatus" = 'valid'
    AND "id" IN (SELECT "recordId" FROM "reflection_record_evidence" WHERE "sessionId" = OLD."id" AND "status" = 'invalid' AND "recordId" = "reflection_records"."id" AND "recordVersion" = "reflection_records"."currentRevision");

  UPDATE "reflection_grants" SET "status" = 'revoked'
  WHERE "status" = 'active' AND "sessionId" = OLD."id";
END;

-- 源会话失权（归档/isTeammate）：与可见性变更同事务封锁该会话的全部证据。
CREATE TRIGGER IF NOT EXISTS "sessions_reflection_source_visibility"
AFTER UPDATE ON "sessions"
WHEN (OLD."archivedAt" IS NULL AND NEW."archivedAt" IS NOT NULL)
   OR OLD."isTeammate" IS NOT NEW."isTeammate"
BEGIN
  INSERT INTO "reflection_cleanup_outbox"
    ("id", "ownerId", "sessionId", "messageId", "kind", "excerpt", "state", "attempts", "createdAt", "updatedAt")
  SELECT lower(hex(randomblob(16))), "ownerId", "sessionId", "messageId", 'source_cleanup', "excerpt", 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "reflection_evidence"
  WHERE "sessionId" = NEW."id" AND "status" = 'valid';

  INSERT INTO "reflection_cleanup_outbox"
    ("id", "ownerId", "sessionId", "messageId", "kind", "excerpt", "state", "attempts", "createdAt", "updatedAt")
  SELECT lower(hex(randomblob(16))), "ownerId", "sessionId", "messageId", 'source_cleanup', "excerpt", 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "reflection_record_evidence"
  WHERE "sessionId" = NEW."id" AND "status" = 'valid';

  UPDATE "reflection_evidence" SET "status" = 'not_ready', "reason" = 'source_unavailable'
  WHERE "sessionId" = NEW."id" AND "status" = 'valid';

  UPDATE "reflection_record_evidence" SET "status" = 'invalid', "reason" = 'source_unavailable'
  WHERE "sessionId" = NEW."id" AND "status" = 'valid';

  UPDATE "reflection_records" SET "evidenceStatus" = 'review_required'
  WHERE "evidenceStatus" = 'valid'
    AND "id" IN (SELECT "recordId" FROM "reflection_record_evidence" WHERE "sessionId" = NEW."id" AND "status" = 'invalid' AND "recordId" = "reflection_records"."id" AND "recordVersion" = "reflection_records"."currentRevision");

  UPDATE "reflection_drafts" SET "status" = 'preparing'
  WHERE "status" IN ('pending', 'confirmed_pending_save') AND "sessionId" = NEW."id";

  UPDATE "reflection_grants" SET "status" = 'revoked'
  WHERE "status" = 'active' AND "sessionId" = NEW."id";

  UPDATE "reflection_presentations" SET "status" = 'revoked', "revokedAt" = CURRENT_TIMESTAMP
  WHERE "status" IN ('active', 'acked') AND "sessionId" = NEW."id";
END;
