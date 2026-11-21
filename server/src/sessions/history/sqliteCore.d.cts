// 历史域只读查询核心（sqliteCore.cjs）的类型声明（#1079）。
import type Database from 'better-sqlite3'
import type {
  HistoryContext,
  HistoryScan,
  HistoryScanOptions,
  HistorySessionQuery,
} from './model'

export interface CoreLimits { sessions?: number }

export declare const HISTORY_DENIED: string
export declare const HISTORY_COOPERATIVE_TIMEOUT: string
export declare function sessions(
  db: Database.Database,
  context: HistoryContext,
  options?: { sessionIds?: readonly string[] },
  limits?: CoreLimits,
  deadline?: number,
): HistorySessionQuery
export declare function scan(
  db: Database.Database,
  context: HistoryContext,
  sessionId: string,
  options: HistoryScanOptions,
  deadline?: number,
): HistoryScan
export declare function probeWrite(db: Database.Database): { readonly: boolean }
