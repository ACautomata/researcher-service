// chat pairing API —— 设备配对控制面（issue #40 / spec §8.1）。
// GET 查询配对状态；POST 触发/重试配对（paired/pending/error 三态出参）。
import { apiJson } from '@/api/client'

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
