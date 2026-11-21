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

export interface SegmentOffset {
  region: 'content' | 'thinking' | 'fields'
  offset: number
  index: number
}

// 长区域分段游标：普通消息返回 undefined（整条一次交付）；长正文/思考按区域连续分段。
export function startSegment(evidence: HistoryEvidence, segmentChars: number): SegmentOffset | undefined {
  if (evidence.content.length <= segmentChars && (evidence.thinking?.length ?? 0) <= segmentChars) return undefined
  if (evidence.content.length > 0) return { region: 'content', offset: 0, index: 1 }
  if (evidence.thinking !== undefined) return { region: 'thinking', offset: 0, index: 1 }
  return undefined
}

export function hasAttachedFields(evidence: HistoryEvidence): boolean {
  return evidence.tools !== undefined || evidence.media !== undefined || evidence.files !== undefined ||
    evidence.filesTotal !== undefined || evidence.hasExec !== undefined
}

// 取一个交付片段；maxChars=0 表示附属性字段段不切分。返回的 next 为空即消息交付完毕。
export function takeEvidencePart(evidence: HistoryEvidence, cursor: SegmentOffset, maxChars: number): {
  part: HistoryEvidence
  next?: SegmentOffset
} {
  const base: HistoryEvidence = {
    session_id: evidence.session_id, message_id: evidence.message_id, turn: evidence.turn, role: evidence.role,
    created_at: evidence.created_at, content: '', missing: evidence.missing, source_truncated: evidence.source_truncated,
  }
  if (cursor.region === 'content') {
    const total = evidence.content.length
    const end = Math.min(total, cursor.offset + Math.max(1, maxChars))
    const part: HistoryEvidence = { ...base, content: evidence.content.slice(cursor.offset, end),
      segment: { region: 'content', index: cursor.index, start: cursor.offset, end, total, next: end < total },
    }
    if (end < total) return { part, next: { region: 'content', offset: end, index: cursor.index + 1 } }
    return { part, ...nextRegionAfterContent(evidence, cursor.index) }
  }
  if (cursor.region === 'thinking') {
    const text = evidence.thinking ?? ''
    const total = text.length
    const end = Math.min(total, cursor.offset + Math.max(1, maxChars))
    const part: HistoryEvidence = { ...base, thinking: text.slice(cursor.offset, end),
      segment: { region: 'thinking', index: cursor.index, start: cursor.offset, end, total, next: end < total },
    }
    if (end < total) return { part, next: { region: 'thinking', offset: end, index: cursor.index + 1 } }
    return { part, ...(hasAttachedFields(evidence) ? { next: { region: 'fields' as const, offset: 0, index: 1 } } : {}) }
  }
  const part: HistoryEvidence = { ...base, attached_fields: true,
    ...(evidence.tools !== undefined ? { tools: evidence.tools } : {}),
    ...(evidence.media !== undefined ? { media: evidence.media } : {}),
    ...(evidence.files !== undefined ? { files: evidence.files } : {}),
    ...(evidence.filesTotal !== undefined ? { filesTotal: evidence.filesTotal } : {}),
    ...(evidence.hasExec !== undefined ? { hasExec: evidence.hasExec } : {}),
  }
  return { part }
}

function nextRegionAfterContent(evidence: HistoryEvidence, index: number): { next?: SegmentOffset } {
  if (evidence.thinking !== undefined) return { next: { region: 'thinking', offset: 0, index: index + 1 } }
  if (hasAttachedFields(evidence)) return { next: { region: 'fields', offset: 0, index: index + 1 } }
  return {}
}
