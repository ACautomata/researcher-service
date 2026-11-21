// 反思内容校验与证据核验纯函数（#1080 · RF-T04）。
//
// 红线：五部分、32KiB 正文、最多 8 条证据、每摘录 ≤1KiB、疑似凭证脱敏；
// 证据位置由服务端从真实来源核验（模型自填的 hash/位置不作证明）。

import { createHash } from 'node:crypto'
import { SENSITIVE_PATTERNS, SENSITIVE_PLACEHOLDER, REFLECTION_LIMITS } from './values'
import type { ReflectionEvidenceStatus } from './values'
import type { CauseAnalysis, DraftBody, DraftScope, EvidenceInput, EvidenceRecord } from './model'

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
