// 外层适配：专用只读连接，可信装配传路径；SQL 参数化、授权与读取同事务。
// RF-T03 将接入独立可硬终止执行器；此适配尚不对生产开放。
import Database from 'better-sqlite3'
import type { HistoryContext, HistoryReader, HistoryReadTarget, HistorySession, HistorySnapshot } from './model'

interface SessionRow { id: string; title: string; createdAt: number | string; latestMessageAt: number | string }
interface MessageRow { id: string; turn: number; role: string; content: string; attachmentsJson: string; createdAt: number | string }
// SQLite CURRENT_TIMESTAMP 是无时区的 UTC 文本；Prisma 则写毫秒数。
const iso = (v: number | string): string => new Date(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(v) ? `${v.replace(' ', 'T')}Z` : v).toISOString()
const milliseconds = (column: string): string => `CASE WHEN typeof(${column}) IN ('integer','real') THEN ${column} ELSE unixepoch(${column},'subsec')*1000 END`

export class SqliteHistoryReader implements HistoryReader {
  constructor(private readonly dbPath: string, private readonly limits = { sessions: 1000, messages: 1000, bytes: 8 * 1024 * 1024 }) {}

  read(context: HistoryContext, sessionIds?: readonly string[], targets?: readonly HistoryReadTarget[]): HistorySnapshot {
    return withHistoryReadConnection(this.dbPath, db => db.transaction(() => {
        // 复核可信调用身份：停用/删除用户、当前线程归属异常均 fail closed。
        const caller = db.prepare(`SELECT s.id FROM sessions s JOIN users u ON u.id=s.ownerId
          WHERE s.id=? AND s.ownerId=? AND s.isTeammate=0 AND s.archivedAt IS NULL AND u.isActive=1`)
          .get(context.currentSessionId, context.ownerId)
        if (!caller) throw new Error('history authorization unavailable')
        const rows = db.prepare(`SELECT s.id,s.title,s.createdAt,
          COALESCE((SELECT MAX(${milliseconds('m.createdAt')}) FROM session_messages m WHERE m.sessionId=s.id AND m.archivedAt IS NULL),${milliseconds('s.createdAt')}) AS latestMessageAt
          FROM sessions s WHERE s.ownerId=? AND s.id<>? AND s.archivedAt IS NULL AND s.isTeammate=0
          ${sessionIds ? `AND s.id IN (${sessionIds.map(() => '?').join(',')})` : ''}
          ORDER BY latestMessageAt DESC,s.id ASC LIMIT ?`)
          .all(context.ownerId, context.currentSessionId, ...(sessionIds ?? []), this.limits.sessions + 1) as SessionRow[]
        let remaining = this.limits.messages
        let bytes = this.limits.bytes
        const sessions: HistorySession[] = []
        for (const row of rows.slice(0, this.limits.sessions)) {
          const messages: HistorySession['messages'] = []
          let limited = false
          // 先读长度，避免无界加载正文和聚合。真正分段/续读由 RF-T02 实现。
          const ranges = targets?.filter(t => t.session_id === row.id)
          const rangeFilter = ranges?.length ? `AND (${ranges.map(() => '(turn>=? AND turn<=?)').join(' OR ')})` : ''
          const rangeArgs = ranges?.flatMap(t => [t.range?.from_turn ?? 1, t.range?.to_turn ?? Number.MAX_SAFE_INTEGER]) ?? []
          const candidates = db.prepare(`SELECT id,length(CAST(content AS BLOB))+length(CAST(attachmentsJson AS BLOB)) AS bytes
            FROM session_messages WHERE sessionId=? AND archivedAt IS NULL ${rangeFilter} ORDER BY turn,${milliseconds('createdAt')},id LIMIT ?`)
            .all(row.id, ...rangeArgs, remaining + 1) as { id: string; bytes: number }[]
          for (const candidate of candidates) {
            if (remaining <= 0 || candidate.bytes > bytes) { limited = true; break }
            const m = db.prepare('SELECT id,turn,role,content,attachmentsJson,createdAt FROM session_messages WHERE id=?').get(candidate.id) as MessageRow
            messages.push({ ...m, createdAt: iso(m.createdAt) })
            remaining--; bytes -= candidate.bytes
          }
          sessions.push({ ...row, createdAt: iso(row.createdAt), latestMessageAt: iso(row.latestMessageAt), messages, limited })
        }
        return { sessions, limited: rows.length > this.limits.sessions || sessions.some(s => s.limited) }
      })())
  }
}

// 真实 adapter 接缝：连接层强制只读；测试可验证误写失败及 finally 释放。
export function withHistoryReadConnection<T>(dbPath: string, read: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try { return read(db) } finally { db.close() }
}
