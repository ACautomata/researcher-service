// 外层适配：专用只读连接，可信装配传路径；SQL 参数化、授权与读取同事务。
// SQL 单一真源 = sqliteCore.cjs（与独立执行进程共用）；本文件是进程内适配与
// 「连接层强制只读」的真实接缝（M6/B4）。
import Database from 'better-sqlite3'
import * as core from './sqliteCore.cjs'
import {
  mapHistoryErrorCode,
  type HistoryContext,
  type HistoryReader,
  type HistoryScan,
  type HistoryScanOptions,
  type HistorySessionQuery,
} from './model'

export class SqliteHistoryReader implements HistoryReader {
  constructor(
    private readonly dbPath: string,
    private readonly limits: { sessions: number } = { sessions: 1000 },
  ) {}

  sessions(context: HistoryContext, options: { sessionIds?: readonly string[] } = {}): HistorySessionQuery {
    return this.readDb(db => core.sessions(db, context, options, this.limits))
  }

  scan(context: HistoryContext, sessionId: string, options: HistoryScanOptions): HistoryScan {
    return this.readDb(db => core.scan(db, context, sessionId, options))
  }

  private readDb<T>(read: (db: Database.Database) => T): T {
    return withHistoryReadConnection(this.dbPath, db => db.transaction(() => read(db))())
  }
}

// 真实 adapter 接缝：连接层强制只读；测试可验证误写失败及 finally 释放。
export function withHistoryReadConnection<T>(dbPath: string, read: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    return read(db)
  } catch (error) {
    throw mapCoreError(error)
  } finally {
    db.close()
  }
}

// 核心（JS）只抛出稳定代码，不把 SQLite 原文/宿主路径带出适配层。
export function mapCoreError(error: unknown): Error {
  const detail = (error as { historyCode?: unknown; denied?: unknown } | null) ?? {}
  return mapHistoryErrorCode(detail.historyCode, detail.denied)
    ?? (error instanceof Error ? error : new Error('history adapter failure'))
}
