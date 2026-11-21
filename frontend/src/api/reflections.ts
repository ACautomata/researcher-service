// reflections API（#1080 RF-T04）：展示读取 + 渲染回执（窄协议；无记录 CRUD）。
// 草稿/正式记录只经 Leader 工具；前端只负责完整展示与 ack。
import { apiJson } from './client'

export interface ReflectionCause {
  text: string
  kind: 'fact' | 'inference'
  evidence: number[]
}

export interface ReflectionScope {
  labels: string[]
  conditions: string
  exclusions: string
}

export interface ReflectionEvidenceView {
  position: number
  sessionId: string
  messageId: string | null
  toolCallId?: string | null
  region: string
  start: number | null
  end: number | null
  excerpt: string
  status: string
  reason?: string
}

export interface ReflectionDisplay {
  displayId: string
  draftId: string
  version: number
  action: string
  bodyHash: string
  status: string
  body: {
    title: string
    category: string
    problem: string
    causes: ReflectionCause[]
    improvements: string[]
    scope: ReflectionScope
  } | null
  // 服务端给的类别中文标签（显示常量单源；body 删除后恒为兜底值）
  categoryLabel: string
  evidence: ReflectionEvidenceView[]
  messageId: string | null
  createdAt: string
  // 服务端实时计算的可确认性（展示 ref 中冻结的 confirmable 会在核验后过期）
  confirmable: boolean
  notConfirmableReason?: string
  deleted?: boolean
}

export interface ReflectionAck {
  seq: number
  ackedAt: string
}

export const getReflectionDisplay = (displayId: string) =>
  apiJson<ReflectionDisplay>(`/api/v1/reflections/displays/${encodeURIComponent(displayId)}`)

export const ackReflectionDisplay = (displayId: string, p: { version: number; hash: string; messageId: string }) =>
  apiJson<ReflectionAck>(`/api/v1/reflections/displays/${encodeURIComponent(displayId)}/ack`, {
    method: 'POST',
    body: JSON.stringify(p),
  })
