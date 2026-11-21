import { parseSavedProduct } from '../productMessage'
import type { HistoryEvidence, HistoryMessageRow } from './model'

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

// 产品字段白名单：保留可靠片段，不输出原始坏 JSON 或未知内部属性。
export function historyEvidence(sessionId: string, row: HistoryMessageRow): HistoryEvidence {
  const parsed = parseSavedProduct(row.attachmentsJson)
  const missing = [...parsed.missing]
  const evidence: HistoryEvidence = {
    session_id: sessionId, message_id: row.id, turn: row.turn, role: row.role,
    created_at: row.createdAt, content: row.content, missing, source_truncated: false,
  }
  const fields = parsed.fields
  if (row.role === 'assistant' && fields.thinking !== undefined) {
    if (typeof fields.thinking === 'string') evidence.thinking = fields.thinking
    else missing.push('thinking')
  }
  const parseRows = (key: 'tools' | 'media' | 'files', strings: readonly string[], numbers: readonly string[], booleans: readonly string[]): void => {
    const value = fields[key]
    if (value === undefined) return
    if (!Array.isArray(value)) { missing.push(key); return }
    const rows: Record<string, unknown>[] = []
    value.forEach((item: unknown, index: number) => {
      if (!isObject(item)) { missing.push(`${key}[${index}]`); return }
      const clean: Record<string, unknown> = {}
      for (const [keys, type] of [[strings, 'string'], [numbers, 'number'], [booleans, 'boolean']] as const) {
        for (const field of keys) {
          if (item[field] === undefined) continue
          if (typeof item[field] === type && (type !== 'number' || Number.isFinite(item[field]))) clean[field] = item[field]
          else missing.push(`${key}[${index}].${field}`)
        }
      }
      if (key === 'tools') {
        for (const field of ['name', 'toolCallId']) if (!clean[field]) missing.push(`${key}[${index}].${field}`)
        if (isObject(item.rejection) && typeof item.rejection.source === 'string' && typeof item.rejection.reason === 'string') {
          clean.rejection = { source: item.rejection.source, reason: item.rejection.reason }
        }
        if (clean.truncated === true) evidence.source_truncated = true
      }
      if (Object.keys(clean).length > 0) rows.push(clean)
      else missing.push(`${key}[${index}]`)
    })
    evidence[key] = rows
  }
  if (row.role === 'assistant') parseRows('tools', ['toolCallId', 'name', 'input', 'state', 'details'], ['durationMs'], ['truncated'])
  parseRows('media', ['attachmentId', 'mime', 'fileName'], ['size', 'width', 'height', 'durationMs'], [])
  parseRows('files', ['path', 'op', 'attachmentId', 'fileName'], ['size'], [])
  if (typeof fields.filesTotal === 'number' && Number.isInteger(fields.filesTotal) && fields.filesTotal >= 0) {
    evidence.filesTotal = fields.filesTotal
    if (fields.filesTotal > (evidence.files?.length ?? 0)) evidence.source_truncated = true
  } else if (fields.filesTotal !== undefined) missing.push('filesTotal')
  if (typeof fields.hasExec === 'boolean') evidence.hasExec = fields.hasExec
  else if (fields.hasExec !== undefined) missing.push('hasExec')
  return evidence
}
