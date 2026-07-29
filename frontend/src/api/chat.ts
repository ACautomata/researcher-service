// chat pairing API —— 设备配对控制面（issue #40 / spec §8.1）。
// GET 查询配对状态；POST 触发/重试配对（paired/pending/error 三态出参）。
import { apiFetch, apiJson } from '@/api/client'
import { ApiError } from '@/api/client'

export interface PairingDTO {
  status: string // unpaired / pending / paired / error
  device_id?: string
  scopes?: string[]
  pairing_request_id?: string
  detail?: string
}

export function getPairing(name: string): Promise<PairingDTO> {
  return apiJson<PairingDTO>(`/api/v1/containers/${encodeURIComponent(name)}/pairing/`)
}

export function triggerPair(name: string): Promise<PairingDTO> {
  return apiJson<PairingDTO>(`/api/v1/containers/${encodeURIComponent(name)}/pairing/`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

// 会话列表（issue #81 / spec #76）：网关权威——后端零持久化，代理容器会话 RPC。
// 出参会话项为网关派生：session_key + title（派生标题）+ updated_at（无 DB id/created_at）。
export interface SessionDTO {
  session_key: string
  title: string
  updated_at: string
}

// GET 返回 {sessions:[...]} 信封（留分页扩展位），此处解包为数组。
export function listSessions(name: string): Promise<SessionDTO[]> {
  return apiJson<{ sessions: SessionDTO[] }>(
    `/api/v1/containers/${encodeURIComponent(name)}/chat/sessions/`,
  ).then((r) => r.sessions)
}

// POST 代理 sessions.create{key,label}：label 可空（网关后续派生标题），201 返回 {session_key}。
export function createSession(name: string, label = ''): Promise<{ session_key: string }> {
  return apiJson<{ session_key: string }>(
    `/api/v1/containers/${encodeURIComponent(name)}/chat/sessions/`,
    { method: 'POST', body: JSON.stringify({ label }) },
  )
}

// 会话历史回看（issue #82 / spec #76）：GET 代理 chat.history，分页锚点 messageId（向回翻页）。
// messages 原样透传网关 display-normalized 消息（字段名「待实测」对齐后端 _parse_history 透传策略，
// 前端翻译层 ChatView.translateHistoryMessage 对 role/text 容错归一）；hasMore/nextOffset 分页字段。
// role/text 标可选以如实表达「待实测」契约——实测确认后可收紧。
export interface HistoryMessageDTO {
  role?: string
  text?: string
  [k: string]: unknown
}

export interface SessionHistoryDTO {
  messages: HistoryMessageDTO[]
  hasMore: boolean
  nextOffset: string | number | null
}

export function getSessionHistory(
  name: string,
  sessionKey: string,
  limit?: number,
  messageId?: string,
): Promise<SessionHistoryDTO> {
  const base =
    `/api/v1/containers/${encodeURIComponent(name)}` +
    `/chat/sessions/${encodeURIComponent(sessionKey)}/history`
  const params = new URLSearchParams()
  if (limit !== undefined) params.set('limit', String(limit))
  if (messageId !== undefined && messageId !== null) params.set('messageId', messageId)
  const qs = params.toString()
  return apiJson<SessionHistoryDTO>(qs ? `${base}?${qs}` : base)
}

// 删除会话（issue #82 / spec #76，admin 级提升权限操作）：DELETE sessions/<key>/，204 空体。
// 204 无 body → 走 apiFetch（同 removeInstance/removeProvider），不经 apiJson 的 resp.json()。
// 删除幂等：404（他人刚删）不报错；未配对 409 / 其它失败抛 ApiError 由调用方处理（ChatView 展示引导）。
export async function deleteSession(name: string, sessionKey: string): Promise<void> {
  const resp = await apiFetch(
    `/api/v1/containers/${encodeURIComponent(name)}` +
      `/chat/sessions/${encodeURIComponent(sessionKey)}/`,
    { method: 'DELETE' },
  )
  if (!resp.ok && resp.status !== 404) {
    let detail = '删除失败'
    try {
      const body = await resp.json()
      if (body && typeof body.detail === 'string') detail = body.detail
    } catch {
      // 无 JSON body（如 204 已被 ok 吞掉），沿用默认 detail
    }
    throw new ApiError(resp.status, detail)
  }
}

// 斜杠命令清单（issue #43 / spec §8.4）：后端代理网关 commands.list，按容器隔离。
// 前端补全契约：name（命令名）+ description（一句话描述）+ aliases（精确斜杠别名，如 /model、/m）。
export interface CommandDTO {
  name: string
  description: string
  aliases: string[]
}

export function listCommands(name: string): Promise<CommandDTO[]> {
  return apiJson<CommandDTO[]>(`/api/v1/containers/${encodeURIComponent(name)}/chat/commands`)
}
