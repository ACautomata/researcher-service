-- #1085：账号删除同清独立反思存储（其余草稿/展示已有外键级联）。
CREATE TRIGGER IF NOT EXISTS reflection_owner_delete
AFTER DELETE ON "users"
BEGIN
  DELETE FROM "reflection_records" WHERE "ownerId" = OLD."id";
  DELETE FROM "reflection_grants" WHERE "ownerId" = OLD."id";
  DELETE FROM "reflection_idempotency" WHERE "ownerId" = OLD."id";
  DELETE FROM "reflection_cleanup_outbox" WHERE "ownerId" = OLD."id";
  DELETE FROM "reflection_events" WHERE "ownerId" = OLD."id";
  DELETE FROM "reflection_confirmation_attempts" WHERE "ownerId" = OLD."id";
  DELETE FROM "reflection_episodes" WHERE "ownerId" = OLD."id";
  DELETE FROM "reflection_request_budgets" WHERE "ownerId" = OLD."id";
END;

CREATE TRIGGER IF NOT EXISTS reflection_safety_owner BEFORE DELETE ON users
WHEN (SELECT locked FROM reflection_recovery_state WHERE id = 'singleton') = 0
BEGIN
 INSERT INTO reflection_safety_journal(ownerId,kind,objectId,state) VALUES (OLD.id,'owner',OLD.id,'deleted');
END;
