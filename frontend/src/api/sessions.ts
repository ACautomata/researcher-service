// sessions API —— 会话 REST 域全量写/读面（#778 / #793 #730 §3.2「REST 写操作面全量重建」）。
// 镜像 server/src/sessions/service.ts 与 sessions/reducer.ts 的 DTO（前端本地定义惯例，同
// api/files.ts）。全部经 apiJson（#312 信封解包 + 401 刷新链）。
// 幂等：POST /messages 须 32-hex Idempotency-Key（服务端 MESSAGE_KEY_REGEX），重发同 key 同
// content 得 replay（runId null / replay true），同 key 异 content → 50007。
import { apiJson } from './client'

export interface SessionSummary { id: string; title: string; createdAt: string; updatedAt: string; parentSessionKey?: string }

// ---- attachmentsJson v1 聚合面（server sessions/reducer.ts ToolLine/MediaRef 逐字段镜像）----
export interface ToolLine {
  toolCallId: string
  name: string
  input: string // JSON 参数字符串（≤1024B 截断，truncated 时可能非法 JSON）
  state: 'running' | 'success' | 'error'
  durationMs?: number
  details?: string // 结果序列化（字符串原样 / 其余 JSON，≤4096B 截断）
  truncated?: boolean
  rejection?: { source: string; reason: string }
}

export interface MediaRef {
  attachmentId: string
  mime: string
  size: number
  fileName: string
  width?: number
  height?: number
  durationMs?: number
}

// #959 轮次产物卡片行（server runner/filejournal/turnFiles.ts TurnFileRow 逐字段镜像）。
// attachmentId/fileName/size 由 T2（#960）物化回填；delete 行恒无 attachmentId。
export type TurnFileOp = 'created' | 'modified' | 'deleted'
export interface TurnFileRow {
  path: string
  op: TurnFileOp
  attachmentId?: string
  fileName?: string
  size?: number
}

export interface TurnContent {
  content: string
  thinking?: string
  tools?: ToolLine[]
  media?: MediaRef[]
  files?: TurnFileRow[]
  // #960 截断计数（server TurnSnapshot.filesTotal 镜像）：files 为截断后列出面，filesTotal =
  // 截断前行数——「等 N 个文件」计数行数据源；files 缺省即无卡，filesTotal 不落键。
  filesTotal?: number
  // #961 exec 提示行标记（server TurnSnapshot.hasExec 镜像）：本轮含 EXEC_TOOLS（Shell）调用
  // ——卡底「本轮含 Shell 调用，其文件副作用不在此列」提示行数据源；true 才落键，缺省无标记。
  hasExec?: boolean
}

// 投影行：attachmentsJson v1 展开进行内（assistant 行 thinking/tools/media；command 面读侧
// 目前不展开 user 行——见 server sessions/service.ts toProjectionMessage）。
export interface ProjectionMessage extends TurnContent {
  id: string
  turn: number
  role: string
  anchorCheckpointId: string | null
  createdAt: string
}

// 在飞投影（#779 story 11）：run queued/running 时 GET /messages 附带，从 checkpoint blob 重建。
export interface LiveTurn { runId: string; state: 'queued' | 'running'; turn: TurnContent }

export interface TeamMember {
  id: string; name: string; task: string; status: string; messages: ProjectionMessage[]; inFlight?: LiveTurn
  mailbox: Array<{ id: string; senderTeammateId: string | null; recipientTeammateId: string | null; kind: string; content: string; createdAt: string }>
}

// 审批中断负载（server runner/approval/values.ts + funnel.ts + plugins/research/experimentPlan.ts
// 镜像）。#920 §1：source 五值含 experiment-plan（W4 方案人审，853 §5.1）；plan 可选块仅
// experiment-plan 携带（方案全文内联几 KB，无独立拉取面）。
export interface ApprovalPlanBlock { title: string; summary: string; text: string; round: number }
export interface ApprovalEscalation {
  id: string
  source: 'cautious-mode' | 'judge-limit' | 'repeat-reject' | 'judge-malformed' | 'experiment-plan'
  toolCallId: string
  toolName: string
  toolCallSummary: string
  judgeReason?: string
  plan?: ApprovalPlanBlock
}
export interface ApprovalInterruptPayload {
  v?: number
  kind?: string
  escalation: ApprovalEscalation
  actionRequests?: Array<{ toolCallId: string; name: string; argsSummary: string }>
}
export interface SessionApproval extends ApprovalInterruptPayload { teammateId?: string | null }

export interface SessionProjection {
  sessionId: string
  title: string
  messages: ProjectionMessage[]
  teammates?: TeamMember[]
  inFlight?: LiveTurn
  approvals?: SessionApproval[]
}

export interface ModelRef { providerId: string; modelId: string }

// 系统命令结果（/new /model；/compact 无独立 command 面——run 正常流式）。
export interface SystemCommandResult {
  name: 'new' | 'model'
  sessionId?: string
  model?: ModelRef | null
  models?: readonly ModelRef[]
  appliesTo?: 'next-run'
}

export interface SendMessageResult {
  messageId: string
  turn: number
  runId: string | null // replay 时 null
  replay: boolean
  command?: SystemCommandResult
}

export interface AttachmentMeta {
  attachmentId: string
  fileName: string
  mimeType: string
  size: number
  sha256: string
  path: string
}

const path = (id: string) => `/api/v1/sessions/${encodeURIComponent(id)}`

// 列表：本人会话扁平挂用户（story 4，容器维度退役；isTeammate/archivedAt 服务端过滤）。
export async function listSessions(): Promise<SessionSummary[]> {
  const data = await apiJson<{ sessions: SessionSummary[] }>('/api/v1/sessions')
  return data?.sessions ?? []
}

export const createSession = (title?: string) =>
  apiJson<SessionSummary>('/api/v1/sessions', { method: 'POST', body: JSON.stringify(title ? { title } : {}) })

// 会话详情 = GET /messages 聚合投影（回放权威读模型；无独立 GET /:id）。
export const getSessionProjection = (id: string) => apiJson<SessionProjection>(`${path(id)}/messages`)

// 改标题（story 5 可改；首轮自动生成经 session.updated 事件到达，无前端触发面）。
export const renameSession = (id: string, title: string) =>
  apiJson<SessionSummary>(path(id), { method: 'PATCH', body: JSON.stringify({ title }) })

// 删除：非终态 run 或存活 teammate 在跑 → 50005（级联删沙箱由服务端负责）。
export const deleteSession = (id: string) => apiJson<null>(path(id), { method: 'DELETE' })

// 发消息：key 原样复用 = replay；attachmentIds 为已上传附件（POST /sessions/:id/attachments 先行）。
export const sendSessionMessage = (id: string, content: string, key: string, attachmentIds?: string[]) =>
  apiJson<SendMessageResult>(`${path(id)}/messages`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify(attachmentIds?.length ? { content, attachmentIds } : { content }),
  })

// 中断（story 8：仅 running 在飞可中断 → 否则 50006）。
export const abortSession = (id: string) => apiJson<{ runId: string }>(`${path(id)}/abort`, { method: 'POST' })

// 审批回覆（#783：decision allow=放行一次 / deny=拒绝；allow-always 已砍）。
// #913：reason 可选随行（W4 方案卡拒绝必填/批准附言，server sessionApprovalSchema reason
// ≤2000 已支持；漏斗卡两键不传）。
export const resolveSessionApproval = (id: string, escalationId: string, decision: 'allow' | 'deny', reason?: string) =>
  apiJson<null>(`${path(id)}/approvals/${encodeURIComponent(escalationId)}`, { method: 'POST', body: JSON.stringify({ decision, ...(reason !== undefined ? { reason } : {}) }) })

// 附件上传（multipart，单文件字段 file；REST 不直写沙箱——物化归图内 ingestion 节点 #780）。
// 入参 Blob + 名称/mime（图片在前端降采样，文件保留原始 Blob；
// 服务端 form 字段 fileName/mimeType 为权威元数据，缺省 'file' / 'application/octet-stream'）。
export function uploadSessionAttachment(id: string, blob: Blob, fileName: string, mimeType: string, signal?: AbortSignal): Promise<AttachmentMeta> {
  const form = new FormData()
  form.append('file', blob, fileName || 'file')
  form.append('fileName', fileName || 'file')
  form.append('mimeType', mimeType || 'application/octet-stream')
  return apiJson<AttachmentMeta>(`${path(id)}/attachments`, { method: 'POST', body: form, timeoutMs: 300_000, signal })
}

// #794 历史操作：消息行作为锚点；branch-switch 已由 #770 取消。
export type RewindScope = 'chat' | 'files' | 'all'
export interface RewindPreview {
  anchor: string
  revertOps: number
  pathSample: string[]
  pathTotal: number
  execCrossed: Array<{ toolCallId: string; input: string }>
}
export interface RewindResult {
  sessionId: string
  activeCheckpointId: string | null
  scope: RewindScope
  files?: { reverted: number; skippedMissing: number; degraded: boolean }
}
export const previewSessionRewind = (id: string, messageId: string) =>
  apiJson<RewindPreview>(`${path(id)}/rewind/preview`, { method: 'POST', body: JSON.stringify({ messageId }) })
export const rewindSession = (id: string, messageId: string, scope: RewindScope) =>
  apiJson<RewindResult>(`${path(id)}/rewind`, { method: 'POST', body: JSON.stringify({ messageId, scope }) })
export const forkSession = (id: string, messageId: string) =>
  apiJson<{ session: SessionSummary }>(`${path(id)}/fork`, { method: 'POST', body: JSON.stringify({ messageId }) })
