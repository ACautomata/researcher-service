// 外层适配：专用只读连接，可信装配传路径；SQL 参数化、授权与读取同事务。
// RF-T03 将接入独立可硬终止执行器；此适配尚不对生产开放。
import Database from 'better-sqlite3'
import {
  HistoryDenied,
  type HistoryContext,
  type HistoryMessageRow,
  type HistoryPosition,
  type HistoryReader,
  type HistoryScan,
  type HistoryScanOptions,
  type HistorySessionQuery,
} from './model'

interface SessionRow { id: string; title: string; createdAt: number | string; latestMessageAt: number | string; version: number | null }
interface UpperRow { sessionId: string; turn: number; createdAt: number | string; id: string }
interface CandidateRow { id: string; turn: number; bytes: number }
interface MessageRow { id: string; turn: number; role: string; content: string; attachmentsJson: string; createdAt: number | string }

// SQLite CURRENT_TIMESTAMP 是无时区的 UTC 文本；Prisma 则写毫秒数。
const iso = (v: number | string): string => new Date(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(v) ? `${v.replace(' ', 'T')}Z` : v).toISOString()
const milliseconds = (column: string): string => `CASE WHEN typeof(${column}) IN ('integer','real') THEN ${column} ELSE unixepoch(${column},'subsec')*1000 END`
const positionOf = (row: { turn: number; createdAt: number | string; id: string }): HistoryPosition => ({
  turn: row.turn, createdAt: iso(row.createdAt), id: row.id,
})
const positionArgs = (position: HistoryPosition): [number, number, string] => [position.turn, Date.parse(position.createdAt), position.id]
// 行值比较与 SQL 排序键同构：(turn, ms(createdAt), id)。
const afterSql = (column: string) => `(${column}.turn, ${milliseconds(`${column}.createdAt`)}, ${column}.id) > (?,?,?)`
const beforeSql = (column: string) => `(${column}.turn, ${milliseconds(`${column}.createdAt`)}, ${column}.id) < (?,?,?)`
const upToSql = (column: string) => `(${column}.turn, ${milliseconds(`${column}.createdAt`)}, ${column}.id) <= (?,?,?)`

export class SqliteHistoryReader implements HistoryReader {
  constructor(
    private readonly dbPath: string,
    private readonly limits = { sessions: 1000 },
  ) {}

  sessions(context: HistoryContext, options: { sessionIds?: readonly string[] } = {}): HistorySessionQuery {
    return this.readDb(db => {
      requireCaller(db, context)
      const ids = options.sessionIds ? [...options.sessionIds] : undefined
      const limit = ids ? Math.max(ids.length, 1) : this.limits.sessions
      const rows = db.prepare(`SELECT s.id,s.title,s.createdAt,COALESCE(v.version,0) AS version,
        COALESCE((SELECT MAX(${milliseconds('m.createdAt')}) FROM session_messages m WHERE m.sessionId=s.id AND m.archivedAt IS NULL),${milliseconds('s.createdAt')}) AS latestMessageAt
        FROM sessions s LEFT JOIN session_history_versions v ON v.sessionId=s.id
        WHERE s.ownerId=? AND s.id<>? AND s.archivedAt IS NULL AND s.isTeammate=0
        ${ids ? `AND s.id IN (${ids.map(() => '?').join(',')})` : ''}
        ORDER BY latestMessageAt DESC,s.id ASC LIMIT ?`)
        .all(context.ownerId, context.currentSessionId, ...(ids ?? []), limit + (ids ? 0 : 1)) as SessionRow[]
      const limited = !ids && rows.length > this.limits.sessions
      const visible = ids ? rows : rows.slice(0, this.limits.sessions)
      const uppers = visible.length
        ? db.prepare(`SELECT sessionId,turn,createdAt,id FROM (
            SELECT m.sessionId,m.turn,m.createdAt,m.id,
              ROW_NUMBER() OVER (PARTITION BY m.sessionId ORDER BY m.turn DESC,${milliseconds('m.createdAt')} DESC,m.id DESC) AS rn
            FROM session_messages m WHERE m.archivedAt IS NULL AND m.sessionId IN (${visible.map(() => '?').join(',')})
          ) WHERE rn=1`).all(...visible.map(row => row.id)) as UpperRow[]
        : []
      const upperById = new Map(uppers.map(row => [row.sessionId, positionOf(row)]))
      const sessions = visible.map(row => ({
        id: row.id,
        title: row.title,
        createdAt: iso(row.createdAt),
        latestMessageAt: iso(row.latestMessageAt),
        version: row.version ?? 0,
        ...(upperById.has(row.id) ? { upper: upperById.get(row.id) } : {}),
      }))
      return { sessions, limited }
    })
  }

  scan(context: HistoryContext, sessionId: string, options: HistoryScanOptions): HistoryScan {
    return this.readDb(db => {
      requireCaller(db, context)
      requireReadable(db, context, sessionId)
      const conditions = ['m.sessionId=?', 'm.archivedAt IS NULL']
      const args: (string | number)[] = [sessionId]
      if (options.range?.from_turn !== undefined) { conditions.push('m.turn>=?'); args.push(options.range.from_turn) }
      if (options.range?.to_turn !== undefined) { conditions.push('m.turn<=?'); args.push(options.range.to_turn) }
      if (options.time?.from !== undefined) { conditions.push(`${milliseconds('m.createdAt')}>=?`); args.push(Date.parse(options.time.from)) }
      if (options.time?.to !== undefined) { conditions.push(`${milliseconds('m.createdAt')}<?`); args.push(Date.parse(options.time.to)) }
      if (options.after) { conditions.push(afterSql('m')); args.push(...positionArgs(options.after)) }
      if (options.upTo) { conditions.push(upToSql('m')); args.push(...positionArgs(options.upTo)) }
      if (options.before) { conditions.push(beforeSql('m')); args.push(...positionArgs(options.before)) }
      if (options.beforeInclusive) { conditions.push(upToSql('m')); args.push(...positionArgs(options.beforeInclusive)) }
      const descending = options.before !== undefined || options.beforeInclusive !== undefined
      const candidates = db.prepare(`SELECT m.id,m.turn,length(CAST(m.content AS BLOB))+length(CAST(m.attachmentsJson AS BLOB)) AS bytes
        FROM session_messages m WHERE ${conditions.join(' AND ')}
        ORDER BY m.turn ${descending ? 'DESC' : 'ASC'},${milliseconds('m.createdAt')} ${descending ? 'DESC' : 'ASC'},m.id ${descending ? 'DESC' : 'ASC'}
        LIMIT ?`).all(...args, options.limitMessages + 1) as CandidateRow[]
      if (descending) candidates.reverse()
      const messages: HistoryMessageRow[] = []
      let bytes = options.limitBytes
      let limited = false
      let truncatedByCount = false
      for (const candidate of candidates) {
        if (messages.length >= options.limitMessages) { truncatedByCount = true; break }
        // 单条超预算仍交付一条，业务层按区域分段推进；否则小预算永远无法到达长消息。
        if (candidate.bytes > bytes && messages.length > 0) { limited = true; break }
        const row = db.prepare('SELECT id,turn,role,content,attachmentsJson,createdAt FROM session_messages WHERE id=?').get(candidate.id) as MessageRow
        messages.push({ ...row, createdAt: iso(row.createdAt) })
        bytes -= candidate.bytes
      }
      const hasMore = limited || truncatedByCount || (candidates.length > messages.length && !descending)
      return { messages, hasMore, limited }
    })
  }

  private readDb<T>(read: (db: Database.Database) => T): T {
    return withHistoryReadConnection(this.dbPath, db => db.transaction(() => read(db))())
  }
}

function requireCaller(db: Database.Database, context: HistoryContext): void {
  const caller = db.prepare(`SELECT s.id FROM sessions s JOIN users u ON u.id=s.ownerId
    WHERE s.id=? AND s.ownerId=? AND s.isTeammate=0 AND s.archivedAt IS NULL AND u.isActive=1`)
    .get(context.currentSessionId, context.ownerId)
  if (!caller) throw new HistoryDenied('authorization')
}

function requireReadable(db: Database.Database, context: HistoryContext, sessionId: string): void {
  if (sessionId === context.currentSessionId) throw new HistoryDenied('current_session')
  const row = db.prepare(`SELECT 1 FROM sessions s WHERE s.id=? AND s.ownerId=? AND s.archivedAt IS NULL AND s.isTeammate=0`)
    .get(sessionId, context.ownerId)
  if (!row) throw new HistoryDenied('unreadable')
}

// 真实 adapter 接缝：连接层强制只读；测试可验证误写失败及 finally 释放。
export function withHistoryReadConnection<T>(dbPath: string, read: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try { return read(db) } finally { db.close() }
}
