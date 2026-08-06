import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'

function runUpgrade(dbPath: string): void {
  execFileSync(process.execPath, ['scripts/upgrade-schema.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdio: 'pipe',
  })
}

describe('schema upgrade script', () => {
  it('adds text trace tables to an existing base database and is idempotent', () => {
    const dir = mkdtempSync(path.join(tmpdir(), `schema-upgrade-${process.pid}-`))
    const dbPath = path.join(dir, 'panel.db')
    const db = new Database(dbPath)
    try {
      db.exec(`
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
PRAGMA user_version=1;
`)
    } finally {
      db.close()
    }

    runUpgrade(dbPath)
    runUpgrade(dbPath)

    const upgraded = new Database(dbPath)
    try {
      const table = upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'text_trace_logs'")
        .get()
      expect(table).toEqual({ name: 'text_trace_logs' })
      const uniqueIndex = upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'text_trace_logs_traceId_key'")
        .get()
      expect(uniqueIndex).toEqual({ name: 'text_trace_logs_traceId_key' })
      expect(upgraded.pragma('user_version', { simple: true })).toBe(2)
    } finally {
      upgraded.close()
    }
  })
})
