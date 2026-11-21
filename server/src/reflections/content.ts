// 反思内容校验与证据核验纯函数（#1080 · RF-T04）。
//
// 红线：五部分、32KiB 正文、最多 8 条证据、每摘录 ≤1KiB、疑似凭证脱敏；
// 证据位置由服务端从真实来源核验（模型自填的 hash/位置不作证明）。

import { createHash } from 'node:crypto'
import {
  REFLECTION_INVALID_EXCERPT_PLACEHOLDER,
  REFLECTION_INVALID_FRAGMENT_PLACEHOLDER,
  REFLECTION_LIMITS,
  REFLECTION_SOURCE_INVALID_REASONS,
  SENSITIVE_PATTERNS,
  SENSITIVE_PLACEHOLDER,
} from './values'
import type { ReflectionEvidenceStatus } from './values'
import type {
  CauseAnalysis,
  DraftBody,
  DraftScope,
  EvidenceInput,
  EvidenceRecord,
  RecordEvidenceRecord,
} from './model'

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export function codePointLength(text: string): number {
  return [...text].length
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

// 脱敏：返回替换后的文本 + 命中的类别（只记录类别，不回显秘密）。
export function redactSensitive(text: string): { text: string; redactions: string[] } {
  let out = text
  const redactions: string[] = []
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0
    out = out.replace(pattern, () => {
      redactions.push('credential')
      return SENSITIVE_PLACEHOLDER
    })
  }
  return { text: out, redactions }
}

export interface NormalizedDraft {
  readonly body: DraftBody
  readonly evidence: readonly EvidenceInput[]
  readonly redactions: number
}

export function normalizeDraftInput(input: {
  category: DraftBody['category']
  title: string
  problem: string
  causes: readonly CauseAnalysis[]
  improvements: readonly string[]
  scope: DraftScope
  evidence: readonly EvidenceInput[]
}): NormalizedDraft | { error: string } {
  if (codePointLength(input.title) > REFLECTION_LIMITS.titleCodePoints) return { error: '标题超过 256 码点' }
  if (input.evidence.length > REFLECTION_LIMITS.evidencePerDraft) return { error: `最多 ${REFLECTION_LIMITS.evidencePerDraft} 条证据` }
  for (const [index, item] of input.evidence.entries()) {
    if (utf8Bytes(item.excerpt) > REFLECTION_LIMITS.excerptBytes) return { error: `证据 ${index + 1} 摘录超过 1KiB` }
  }
  if (input.scope.labels.length > REFLECTION_LIMITS.scopeLabels) return { error: `最多 ${REFLECTION_LIMITS.scopeLabels} 个适用范围标签` }
  for (const label of input.scope.labels) {
    if (codePointLength(label) > REFLECTION_LIMITS.scopeLabelCodePoints) return { error: '适用范围标签超过 64 码点' }
  }

  let redactions = 0
  const clean = (value: string): string => {
    const r = redactSensitive(value)
    redactions += r.redactions.length
    return r.text
  }

  const causes: CauseAnalysis[] = []
  for (const c of input.causes) {
    // 关联证据位置越界即拒绝（不静默丢弃事实/推测关联）。
    for (const position of c.evidence) {
      if (position < 1 || position > input.evidence.length) return { error: '原因关联的证据位置不存在' }
    }
    causes.push({ text: clean(c.text), kind: c.kind, evidence: [...c.evidence] })
  }
  const body: DraftBody = {
    title: clean(input.title),
    category: input.category,
    problem: clean(input.problem),
    causes,
    improvements: input.improvements.map(clean),
    scope: {
      labels: input.scope.labels.map(clean),
      conditions: clean(input.scope.conditions),
      exclusions: clean(input.scope.exclusions),
    },
  }
  if (utf8Bytes(JSON.stringify(body)) > REFLECTION_LIMITS.bodyBytes) return { error: '草稿正文超过 32KiB' }

  // 原始摘录保留（仅内存内用于服务端核验，不落库）；展示/持久面用脱敏后的副本。
  const evidence = input.evidence.map((item) => {
    const r = redactSensitive(item.excerpt)
    redactions += r.redactions.length
    return { ...item, displayExcerpt: r.text }
  })
  return { body, evidence, redactions }
}


// Unicode 码点切片（与父规格「Unicode 码点范围」一致，不按 UTF-16 单元）。
export function codePointSlice(text: string, start: number, end: number): string {
  return [...text].slice(start, end).join('')
}

export interface ExcerptMatch {
  readonly start: number
  readonly end: number
  readonly regionHash: string
}

// 服务端按真实来源核验摘录：给范围则要求该范围原文逐字等于摘录；未给范围则取首次出现。
export function matchExcerpt(
  regionText: string,
  excerpt: string,
  start?: number,
  end?: number,
): ExcerptMatch | { error: 'not_found' | 'range_mismatch' | 'invalid_range' } {
  const points = [...regionText]
  const regionHash = sha256(regionText)
  if (start !== undefined || end !== undefined) {
    if (start === undefined || end === undefined) return { error: 'invalid_range' }
    if (start < 0 || end > points.length || end < start) return { error: 'invalid_range' }
    const slice = points.slice(start, end).join('')
    if (slice !== excerpt) return { error: 'range_mismatch' }
    return { start, end, regionHash }
  }
  const excerptPoints = [...excerpt]
  if (excerptPoints.length === 0) return { error: 'not_found' }
  for (let i = 0; i + excerptPoints.length <= points.length; i++) {
    let hit = true
    for (let j = 0; j < excerptPoints.length; j++) {
      if (points[i + j] !== excerptPoints[j]) { hit = false; break }
    }
    if (hit) return { start: i, end: i + excerptPoints.length, regionHash }
  }
  return { error: 'not_found' }
}

// 消息内容版本：正文 + 已保存产品聚合的稳定散列（内容/附件任一变化即变）。
export function contentVersionOf(content: string, attachmentsJson: string): string {
  return sha256(`${content}\u0000${attachmentsJson}`)
}

export interface EvidenceView {
  readonly position: number
  readonly sessionId: string
  readonly messageId: string | null
  readonly toolCallId: string | null
  readonly region: string
  readonly start: number | null
  readonly end: number | null
  readonly excerpt: string
  readonly status: ReflectionEvidenceStatus
  readonly reason?: string
}

export function evidenceViews(evidence: readonly EvidenceRecord[]): EvidenceView[] {
  return evidence.map((e) => ({
    position: e.position,
    sessionId: e.sessionId,
    messageId: e.messageId,
    toolCallId: e.toolCallId,
    region: e.region,
    start: e.startCp,
    end: e.endCp,
    excerpt: e.excerpt,
    status: e.status,
    ...(e.reason !== undefined ? { reason: e.reason } : {}),
  }))
}

// ---- #1084（RF-T08）：来源失效摘录与正文副本的同步封锁/清理 ----

export function isSourceInvalidReason(reason: string | undefined): boolean {
  return reason !== undefined && (REFLECTION_SOURCE_INVALID_REASONS as readonly string[]).includes(reason)
}

/** 失效草稿证据的摘录原文（读门封锁 + 正文副本清理的 needle 集合）。 */
export function blockedDraftExcerpts(evidence: readonly EvidenceRecord[]): string[] {
  return evidence
    .filter((e) => e.status !== 'valid' && isSourceInvalidReason(e.reason))
    .map((e) => e.excerpt)
    .filter((text) => text.length > 0)
}

export function blockedRecordExcerpts(evidence: readonly RecordEvidenceRecord[]): string[] {
  return evidence
    .filter((e) => e.status === 'invalid')
    .map((e) => e.excerpt)
    .filter((text) => text.length > 0)
}

/** 把正文中逐字复制的来源片段替换为占位（父规格 I4：不按字段名区分，正文/原因同样清理）。 */
export function scrubSourceFragment(text: string, excerpts: readonly string[]): string {
  let out = text
  // 长摘录优先，避免短摘录先替换后长摘录失配。
  for (const needle of [...excerpts].sort((a, b) => b.length - a.length)) {
    if (needle.length === 0) continue
    out = out.split(needle).join(REFLECTION_INVALID_FRAGMENT_PLACEHOLDER)
  }
  return out
}

export function scrubDraftBody(body: DraftBody, excerpts: readonly string[]): DraftBody {
  if (excerpts.length === 0) return body
  const clean = (value: string): string => scrubSourceFragment(value, excerpts)
  return {
    title: clean(body.title),
    category: body.category,
    problem: clean(body.problem),
    causes: body.causes.map((c) => ({ ...c, text: clean(c.text) })),
    improvements: body.improvements.map(clean),
    scope: {
      labels: body.scope.labels.map(clean),
      conditions: clean(body.scope.conditions),
      exclusions: clean(body.scope.exclusions),
    },
  }
}

/** 展示/记录正文 JSON（含五部分 + 证据视图）的副本清理；不可解析时原样返回（不吞掉错误结构）。 */
export function scrubBodyJson(raw: string, excerpts: readonly string[]): string {
  if (excerpts.length === 0) return raw
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!value || typeof value !== 'object') return raw
  const record = value as Record<string, unknown>
  const body: DraftBody = {
    title: typeof record.title === 'string' ? record.title : '',
    category: typeof record.category === 'string' ? record.category as DraftBody['category'] : 'other',
    problem: typeof record.problem === 'string' ? record.problem : '',
    causes: Array.isArray(record.causes) ? record.causes as DraftBody['causes'] : [],
    improvements: Array.isArray(record.improvements) ? record.improvements as string[] : [],
    scope: record.scope && typeof record.scope === 'object'
      ? {
          labels: Array.isArray((record.scope as DraftScope).labels) ? (record.scope as DraftScope).labels : [],
          conditions: typeof (record.scope as DraftScope).conditions === 'string' ? (record.scope as DraftScope).conditions : '',
          exclusions: typeof (record.scope as DraftScope).exclusions === 'string' ? (record.scope as DraftScope).exclusions : '',
        }
      : { labels: [], conditions: '', exclusions: '' },
  }
  const cleaned = scrubDraftBody(body, excerpts)
  const evidence = Array.isArray(record.evidence)
    ? (record.evidence as Record<string, unknown>[]).map((item) => ({
        ...item,
        ...(typeof item.excerpt === 'string' ? { excerpt: scrubSourceFragment(item.excerpt, excerpts) } : {}),
      }))
    : record.evidence
  return JSON.stringify({ ...record, ...cleaned, ...(evidence !== undefined ? { evidence } : {}) })
}

/** 读门证据视图：来源失效的摘录以占位替代，绝不把已封锁正文交回调用方。 */
export function sanitizedDraftEvidenceViews(evidence: readonly EvidenceRecord[]): EvidenceView[] {
  return evidenceViews(evidence).map((view, index) => {
    const record = evidence[index]
    if (record === undefined) return view
    if (record.status !== 'valid' && isSourceInvalidReason(record.reason)) {
      return { ...view, excerpt: REFLECTION_INVALID_EXCERPT_PLACEHOLDER }
    }
    return view
  })
}

export function sanitizedRecordEvidenceViews(evidence: readonly RecordEvidenceRecord[]): Array<{
  position: number
  sessionId: string
  messageId: string | null
  toolCallId: string | null
  region: string
  start: number | null
  end: number | null
  excerpt: string
  status: string
  reason?: string
}> {
  return evidence.map((e) => ({
    position: e.position,
    sessionId: e.sessionId,
    messageId: e.messageId,
    toolCallId: e.toolCallId,
    region: e.region,
    start: e.startCp,
    end: e.endCp,
    excerpt: e.status === 'invalid' ? REFLECTION_INVALID_EXCERPT_PLACEHOLDER : e.excerpt,
    status: e.status,
    ...(e.reason !== undefined ? { reason: e.reason } : {}),
  }))
}

// 展示正文的唯一序列化实现（hash 与持久正文同源——防两处副本漂移）。
export function presentationPayload(p: {
  body: DraftBody
  evidence: readonly EvidenceRecord[]
  version: number
  action: string
}): Record<string, unknown> {
  return {
    title: p.body.title,
    category: p.body.category,
    problem: p.body.problem,
    causes: p.body.causes,
    improvements: p.body.improvements,
    scope: p.body.scope,
    evidence: evidenceViews(p.evidence),
    version: p.version,
    action: p.action,
  }
}

export function presentationJson(p: Parameters<typeof presentationPayload>[0]): string {
  return JSON.stringify(presentationPayload(p))
}
