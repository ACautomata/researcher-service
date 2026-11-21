// 历史域只读 SQLite 查询核心（#1079 · RF-T03）。
//
// 单一 SQL 真源：`SqliteHistoryReader`（进程内适配）与独立执行进程（executor.ts 的
// child）都调用本文件。连接只读由调用方打开时强制；本文件只做参数化查询与授权。
//
// 协作时限（2 秒）在逐行/逐候选循环内检查——长原生查询无法协作中断时才由执行进程硬
// 终止（SIGKILL），绝不以 Promise.race 冒充终止。

const HISTORY_DENIED = 'history_denied'
const HISTORY_COOPERATIVE_TIMEOUT = 'history_cooperative_timeout'

function denied(code) {
  const error = new Error(code)
  error.historyCode = HISTORY_DENIED
  error.denied = code
  return error
}

function cooperativeTimeout() {
  const error = new Error('cooperative timeout')
  error.historyCode = HISTORY_COOPERATIVE_TIMEOUT
  return error
}

function checkDeadline(deadline) {
  if (deadline !== undefined && Date.now() > deadline) throw cooperativeTimeout()
}

const iso = (v) => new Date(
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(v)
    ? `${v.replace(' ', 'T')}Z`
    : v,
).toISOString()
const milliseconds = (column) =>
  `CASE WHEN typeof(${column}) IN ('integer','real') THEN ${column} ELSE unixepoch(${column},'subsec')*1000 END`
const positionOf = (row) => ({ turn: row.turn, createdAt: iso(row.createdAt), id: row.id })
const positionArgs = (position) => [position.turn, Date.parse(position.createdAt), position.id]
const afterSql = (column) => `(${column}.turn, ${milliseconds(`${column}.createdAt`)}, ${column}.id) > (?,?,?)`
const beforeSql = (column) => `(${column}.turn, ${milliseconds(`${column}.createdAt`)}, ${column}.id) < (?,?,?)`
const upToSql = (column) => `(${column}.turn, ${milliseconds(`${column}.createdAt`)}, ${column}.id) <= (?,?,?)`

function requireCaller(db, context) {
  const caller = db
    .prepare(`SELECT s.id FROM sessions s JOIN users u ON u.id=s.ownerId
      WHERE s.id=? AND s.ownerId=? AND s.isTeammate=0 AND s.archivedAt IS NULL AND u.isActive=1`)
    .get(context.currentSessionId, context.ownerId)
  if (!caller) throw denied('authorization')
}

function requireReadable(db, context, sessionId) {
  if (sessionId === context.currentSessionId) throw denied('current_session')
  const row = db
    .prepare(`SELECT 1 FROM sessions s WHERE s.id=? AND s.ownerId=? AND s.archivedAt IS NULL AND s.isTeammate=0`)
    .get(sessionId, context.ownerId)
  if (!row) throw denied('unreadable')
}

function sessions(db, context, options, limits, deadline) {
  requireCaller(db, context)
  checkDeadline(deadline)
  const ids = options && options.sessionIds ? [...options.sessionIds] : undefined
  const limit = ids ? Math.max(ids.length, 1) : (limits && limits.sessions) || 1000
  const rows = db
    .prepare(`SELECT s.id,s.title,s.createdAt,COALESCE(v.version,0) AS version,
      COALESCE((SELECT MAX(${milliseconds('m.createdAt')}) FROM session_messages m WHERE m.sessionId=s.id AND m.archivedAt IS NULL),${milliseconds('s.createdAt')}) AS latestMessageAt
      FROM sessions s LEFT JOIN session_history_versions v ON v.sessionId=s.id
      WHERE s.ownerId=? AND s.id<>? AND s.archivedAt IS NULL AND s.isTeammate=0
      ${ids ? `AND s.id IN (${ids.map(() => '?').join(',')})` : ''}
      ORDER BY latestMessageAt DESC,s.id ASC LIMIT ?`)
    .all(context.ownerId, context.currentSessionId, ...(ids ?? []), limit + (ids ? 0 : 1))
  checkDeadline(deadline)
  const limited = !ids && rows.length > limit
  const visible = ids ? rows : rows.slice(0, limit)
  const uppers = visible.length
    ? db
        .prepare(`SELECT sessionId,turn,createdAt,id FROM (
          SELECT m.sessionId,m.turn,m.createdAt,m.id,
            ROW_NUMBER() OVER (PARTITION BY m.sessionId ORDER BY m.turn DESC,${milliseconds('m.createdAt')} DESC,m.id DESC) AS rn
          FROM session_messages m WHERE m.archivedAt IS NULL AND m.sessionId IN (${visible.map(() => '?').join(',')})
        ) WHERE rn=1`)
        .all(...visible.map((row) => row.id))
    : []
  const upperById = new Map(uppers.map((row) => [row.sessionId, positionOf(row)]))
  const result = visible.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: iso(row.createdAt),
    latestMessageAt: iso(row.latestMessageAt),
    version: row.version ?? 0,
    ...(upperById.has(row.id) ? { upper: upperById.get(row.id) } : {}),
  }))
  return { sessions: result, limited }
}

function scan(db, context, sessionId, options, deadline) {
  requireCaller(db, context)
  requireReadable(db, context, sessionId)
  const conditions = ['m.sessionId=?', 'm.archivedAt IS NULL']
  const args = [sessionId]
  if (options.range && options.range.from_turn !== undefined) {
    conditions.push('m.turn>=?')
    args.push(options.range.from_turn)
  }
  if (options.range && options.range.to_turn !== undefined) {
    conditions.push('m.turn<=?')
    args.push(options.range.to_turn)
  }
  if (options.time && options.time.from !== undefined) {
    conditions.push(`${milliseconds('m.createdAt')}>=?`)
    args.push(Date.parse(options.time.from))
  }
  if (options.time && options.time.to !== undefined) {
    conditions.push(`${milliseconds('m.createdAt')}<?`)
    args.push(Date.parse(options.time.to))
  }
  if (options.after) {
    conditions.push(afterSql('m'))
    args.push(...positionArgs(options.after))
  }
  if (options.upTo) {
    conditions.push(upToSql('m'))
    args.push(...positionArgs(options.upTo))
  }
  if (options.before) {
    conditions.push(beforeSql('m'))
    args.push(...positionArgs(options.before))
  }
  if (options.beforeInclusive) {
    conditions.push(upToSql('m'))
    args.push(...positionArgs(options.beforeInclusive))
  }
  checkDeadline(deadline)
  const descending = options.before !== undefined || options.beforeInclusive !== undefined
  const candidates = db
    .prepare(`SELECT m.id,m.turn,length(CAST(m.content AS BLOB))+length(CAST(m.attachmentsJson AS BLOB)) AS bytes
      FROM session_messages m WHERE ${conditions.join(' AND ')}
      ORDER BY m.turn ${descending ? 'DESC' : 'ASC'},${milliseconds('m.createdAt')} ${descending ? 'DESC' : 'ASC'},m.id ${descending ? 'DESC' : 'ASC'}
      LIMIT ?`)
    .all(...args, options.limitMessages + 1)
  if (descending) candidates.reverse()
  const messages = []
  let bytes = options.limitBytes
  let limited = false
  let truncatedByCount = false
  const getRow = db.prepare('SELECT id,turn,role,content,attachmentsJson,createdAt FROM session_messages WHERE id=?')
  for (const candidate of candidates) {
    checkDeadline(deadline)
    if (messages.length >= options.limitMessages) {
      truncatedByCount = true
      break
    }
    // 单条超预算仍交付一条，业务层按区域分段推进；否则小预算永远无法到达长消息。
    if (candidate.bytes > bytes && messages.length > 0) {
      limited = true
      break
    }
    const row = getRow.get(candidate.id)
    messages.push({ ...row, createdAt: iso(row.createdAt) })
    bytes -= candidate.bytes
  }
  const hasMore = limited || truncatedByCount || (candidates.length > messages.length && !descending)
  return { messages, hasMore, limited }
}

// 验证缝（B4/M6）：只读连接上的写操作必须失败；不返回任何原始 SQLite 错误文本。
function probeWrite(db) {
  try {
    db.prepare(`DELETE FROM session_messages WHERE 0`).run()
    return { readonly: false }
  } catch {
    return { readonly: true }
  }
}

module.exports = {
  HISTORY_COOPERATIVE_TIMEOUT,
  HISTORY_DENIED,
  probeWrite,
  scan,
  sessions,
}
