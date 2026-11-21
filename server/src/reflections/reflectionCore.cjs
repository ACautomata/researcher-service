// #1082（RF-T06）反思记录检索只读 SQL 核心。由 utils/readonlyProcessChild.cjs 在独立子进程加载；
// 参数化 SQL 只用静态白名单列（owner/状态/类别/ID），不做 regex/FTS/向量；逐行检查协作时限。

const COOPERATIVE_TIMEOUT = 'cooperative_timeout'

const CATEGORY_LABELS = {
  understanding: '需求理解',
  planning: '计划',
  tool_use: '工具使用',
  verification: '验证',
  efficiency: '效率',
  information_access: '信息获取',
  other: '其他',
}

function cooperativeTimeout() {
  const error = new Error('cooperative timeout')
  error.readonlyCode = COOPERATIVE_TIMEOUT
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

function parseJson(raw, fallback) {
  try {
    const value = JSON.parse(raw)
    return value === null || value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

function normalized(text) {
  return String(text).normalize('NFKC').toLowerCase()
}

function bodyOf(raw) {
  const value = parseJson(raw, {})
  return value && typeof value === 'object' ? value : {}
}

function scopeLabelsOf(body) {
  const labels = body.scope && Array.isArray(body.scope.labels) ? body.scope.labels : []
  return labels.filter((label) => typeof label === 'string')
}

function searchableText(body) {
  const causes = Array.isArray(body.causes) ? body.causes.map((c) => (c && typeof c.text === 'string' ? c.text : '')) : []
  const improvements = Array.isArray(body.improvements) ? body.improvements : []
  const scope = body.scope && typeof body.scope === 'object' ? body.scope : {}
  return normalized([
    typeof body.title === 'string' ? body.title : '',
    typeof body.problem === 'string' ? body.problem : '',
    ...causes,
    ...improvements,
    typeof scope.conditions === 'string' ? scope.conditions : '',
    typeof scope.exclusions === 'string' ? scope.exclusions : '',
    typeof body.category === 'string' ? body.category : '',
    CATEGORY_LABELS[body.category] || '',
    ...scopeLabelsOf(body),
  ].join('\n'))
}

function summaryOf(row) {
  const body = bodyOf(row.contentJson)
  return {
    record_id: row.id,
    version: row.currentRevision,
    title: row.title,
    category: row.category,
    scope_labels: scopeLabelsOf(body),
    status: row.status,
    evidence_status: row.evidenceStatus,
    updated_at: iso(row.updatedAt),
  }
}

function placeholders(values) {
  return values.map(() => '?').join(',')
}

// 目录/关键词搜索：SQL 预过滤 owner/状态/证据状态/类别，程序逐记录做 NFKC+小写 AND 与标签交集。
// 返回全部匹配摘要（固定快照由业务层冻结并分页）。
function searchRecords(db, p, deadline) {
  checkDeadline(deadline)
  const states = Array.isArray(p.states) && p.states.length > 0 ? p.states : ['active']
  const evidenceStates = Array.isArray(p.evidenceStatuses) && p.evidenceStatuses.length > 0 ? p.evidenceStatuses : ['valid']
  const category = typeof p.category === 'string' ? p.category : undefined
  const words = Array.isArray(p.words) ? p.words.filter((w) => typeof w === 'string' && w.length > 0) : []
  const labels = Array.isArray(p.labels)
    ? p.labels.filter((w) => typeof w === 'string' && w.length > 0).map(normalized)
    : []
  const maxRecords = typeof p.maxRecords === 'number' && p.maxRecords > 0 ? p.maxRecords : 2000
  const args = [p.ownerId, ...states, ...evidenceStates]
  const sql = `SELECT id,title,category,contentJson,status,evidenceStatus,currentRevision,updatedAt
    FROM reflection_records
    WHERE ownerId=? AND status IN (${placeholders(states)}) AND evidenceStatus IN (${placeholders(evidenceStates)})
    ${category !== undefined ? 'AND category=?' : ''}
    ORDER BY updatedAt DESC, id ASC`
  if (category !== undefined) args.push(category)
  const rows = db.prepare(sql).all(...args)

  const records = []
  for (const row of rows) {
    checkDeadline(deadline)
    const body = bodyOf(row.contentJson)
    if (labels.length > 0) {
      const own = scopeLabelsOf(body).map(normalized)
      if (!labels.every((label) => own.includes(label))) continue
    }
    if (words.length > 0) {
      const haystack = searchableText(body)
      if (!words.every((word) => haystack.includes(word))) continue
    }
    records.push(summaryOf(row))
    if (records.length >= maxRecords) return { records, limited: true }
  }
  return { records, limited: false }
}

// 后续页的固定快照复核 + 摘要回读：只读 owner 名下指定 ID。
function recordVersions(db, p, deadline) {
  checkDeadline(deadline)
  const ids = Array.isArray(p.ids) ? p.ids.filter((id) => typeof id === 'string' && id.length > 0) : []
  if (ids.length === 0) return { records: [] }
  const rows = db.prepare(`SELECT id,title,category,contentJson,currentRevision,status,evidenceStatus,updatedAt
    FROM reflection_records WHERE ownerId=? AND id IN (${placeholders(ids)})`).all(p.ownerId, ...ids)
  return { records: rows.map(summaryOf) }
}

// read：按目标输入顺序逐项返回；experience 只读 active+valid，management 可读历史版本与失效状态。
function readRecords(db, p, deadline) {
  const targets = Array.isArray(p.targets) ? p.targets : []
  const out = []
  for (const target of targets) {
    checkDeadline(deadline)
    const recordId = target && typeof target.record_id === 'string' ? target.record_id : ''
    const requestedVersion = target && Number.isInteger(target.version) ? target.version : undefined
    const row = db.prepare(`SELECT id,title,category,contentJson,status,evidenceStatus,currentRevision,updatedAt
      FROM reflection_records WHERE id=? AND ownerId=?`).get(recordId, p.ownerId)
    if (!row) {
      out.push({ record_id: recordId, status: 'not_found' })
      continue
    }
    if (p.experience) {
      if (row.status !== 'active' || row.evidenceStatus !== 'valid') {
        out.push({ record_id: row.id, status: 'unreadable' })
        continue
      }
      if (requestedVersion !== undefined && requestedVersion !== row.currentRevision) {
        out.push({ record_id: row.id, status: 'conflict', expected_version: requestedVersion, actual_version: row.currentRevision })
        continue
      }
    } else if (row.status === 'deleted') {
      out.push({ record_id: row.id, status: 'deleted' })
      continue
    }
    const version = requestedVersion ?? row.currentRevision
    const revision = db.prepare('SELECT version,bodyJson,bodyHash,evidenceJson FROM reflection_revisions WHERE recordId=? AND version=?')
      .get(row.id, version)
    if (!revision) {
      out.push(requestedVersion !== undefined
        ? { record_id: row.id, status: 'conflict', expected_version: requestedVersion, actual_version: row.currentRevision }
        : { record_id: row.id, status: 'not_found' })
      continue
    }
    const evidence = parseJson(revision.evidenceJson, [])
    out.push({
      record_id: row.id,
      status: 'ok',
      version,
      is_current: version === row.currentRevision,
      title: row.title,
      category: row.category,
      scope_labels: scopeLabelsOf(bodyOf(row.contentJson)),
      record_status: row.status,
      evidence_status: row.evidenceStatus,
      updated_at: iso(row.updatedAt),
      body_json: revision.bodyJson,
      body_hash: revision.bodyHash,
      evidence: Array.isArray(evidence) ? evidence.map((e) => ({
        position: e.position,
        session_id: e.sessionId ?? e.session_id ?? null,
        message_id: e.messageId ?? e.message_id ?? null,
        tool_call_id: e.toolCallId ?? e.tool_call_id ?? null,
        region: e.region,
        start: e.startCp ?? e.start ?? null,
        end: e.endCp ?? e.end ?? null,
        excerpt: e.excerpt,
        status: e.status,
        ...(e.reason ? { reason: e.reason } : {}),
      })) : [],
    })
  }
  return { records: out }
}

// 验证缝：真实只读连接拒绝写入。
function probeWrite(db) {
  try {
    db.exec('CREATE TABLE __rf_write_probe (x INTEGER)')
    db.exec('DROP TABLE __rf_write_probe')
    return { readonly: false }
  } catch {
    return { readonly: true }
  }
}

module.exports = { COOPERATIVE_TIMEOUT, searchRecords, recordVersions, readRecords, probeWrite }
