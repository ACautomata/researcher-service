-- #1085：账号删除同清独立反思存储（其余草稿/展示已有外键级联）。
CREATE TRIGGER IF NOT EXISTS reflection_owner_delete
AFTER DELETE ON "users"
BEGIN
  DELETE FROM "reflection_records" WHERE "ownerId" = OLD."id";
  DELETE FROM "reflection_grants" WHERE "ownerId" = OLD."id";
  DELETE FROM "reflection_idempotency" WHERE "ownerId" = OLD."id";
  DELETE FROM "reflection_cleanup_outbox" WHERE "ownerId" = OLD."id";
  DELETE FROM "reflection_events" WHERE "ownerId" = OLD."id";
  DELETE FROM "reflection_episodes" WHERE "ownerId" = OLD."id";
  DELETE FROM "reflection_request_budgets" WHERE "ownerId" = OLD."id";
END;
