-- 无内容安全日志；独立于90天访问事件保留期，备份链存续期间不清理。
CREATE TABLE IF NOT EXISTS reflection_recovery_state (
 id TEXT PRIMARY KEY, lineage TEXT NOT NULL, locked INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO reflection_recovery_state(id,lineage,locked) VALUES ('singleton',lower(hex(randomblob(16))),0);
CREATE TABLE IF NOT EXISTS reflection_safety_journal (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, ownerId TEXT NOT NULL, kind TEXT NOT NULL,
 objectId TEXT NOT NULL, state TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS reflection_safety_record AFTER UPDATE ON reflection_records
WHEN (SELECT locked FROM reflection_recovery_state WHERE id = 'singleton') = 0
BEGIN
 INSERT INTO reflection_safety_journal(ownerId,kind,objectId,state) VALUES (NEW.ownerId,'record',NEW.id,NEW.status);
END;
CREATE TRIGGER IF NOT EXISTS reflection_safety_source AFTER UPDATE OF status ON reflection_record_evidence
WHEN NEW.status IN ('invalid','not_ready') AND (SELECT locked FROM reflection_recovery_state WHERE id = 'singleton') = 0
BEGIN
 INSERT INTO reflection_safety_journal(ownerId,kind,objectId,state) VALUES (NEW.ownerId,'source',NEW.sessionId,COALESCE(NEW.messageId,''));
END;
CREATE TRIGGER IF NOT EXISTS reflection_safety_draft_source AFTER UPDATE OF status ON reflection_evidence
WHEN NEW.status IN ('invalid','not_ready') AND (SELECT locked FROM reflection_recovery_state WHERE id = 'singleton') = 0
BEGIN
 INSERT INTO reflection_safety_journal(ownerId,kind,objectId,state) VALUES (NEW.ownerId,'source',NEW.sessionId,COALESCE(NEW.messageId,''));
END;
