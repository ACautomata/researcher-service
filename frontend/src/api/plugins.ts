import { apiJson } from './client'

export interface PluginSummary {
  id: string
  name: string
  description: string
  version: string
  enabled: boolean
  commands: readonly { name: string; description: string; hasArgumentCompletions?: boolean }[]
}

export async function listPlugins(): Promise<PluginSummary[]> {
  const data = await apiJson<{ plugins: PluginSummary[] }>('/api/v1/plugins')
  return data.plugins
}

// 启用位切换（#752 §4.3 R8 / #799 目录页）：幂等 upsert；禁用只影响新 run 装配
//（进行中 run 不中断——服务端 per-run 快照语义，Q12）。
export async function setPluginEnablement(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean }> {
  return apiJson<{ id: string; enabled: boolean }>(`/api/v1/plugins/${encodeURIComponent(id)}/enablement`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}

export interface ArgumentCompletion { value: string; description?: string }

export async function getPluginArgumentCompletions(pluginId: string, name: string, prefix: string): Promise<ArgumentCompletion[]> {
  const query = new URLSearchParams({ prefix })
  const data = await apiJson<{ completions: ArgumentCompletion[] }>(`/api/v1/plugins/${encodeURIComponent(pluginId)}/commands/${encodeURIComponent(name)}/completions?${query}`)
  return data.completions
}

// ---------------------------------------------------------------------------
// 插件 LLM 指派（#883 T3）：per-user per-plugin 端点/模型指派（Model 页插件指派区）。
// targets = 声明 llm 的插件 ∪ 保留键 'judge'（审批判定器）——后端目录派生，前端零硬编码；
// provider_id null = 跟随默认链；'platform' = 钉平台默认端点。写后服务端事务内 bump
// 配置版本（热生效——下一 run 生效，在飞 run 不受影响）。
// ---------------------------------------------------------------------------

export interface PluginLlmTargetDTO {
  plugin_id: string
  description: string
  default_model?: string
}

export interface PluginLlmAssignmentDTO {
  plugin_id: string
  provider_id: string | null
  model_id: string | null
  updated_at: string
}

export interface LlmAssignmentsDTO {
  targets: PluginLlmTargetDTO[]
  assignments: PluginLlmAssignmentDTO[]
}

export async function listLlmAssignments(): Promise<LlmAssignmentsDTO> {
  return apiJson<LlmAssignmentsDTO>('/api/v1/plugins/llm-assignments')
}

export async function setLlmAssignment(
  id: string,
  payload: { provider_id: string | null; model_id: string | null },
): Promise<PluginLlmAssignmentDTO> {
  return apiJson<PluginLlmAssignmentDTO>(`/api/v1/plugins/${encodeURIComponent(id)}/llm-assignment`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export async function clearLlmAssignment(id: string): Promise<void> {
  await apiJson<null>(`/api/v1/plugins/${encodeURIComponent(id)}/llm-assignment`, { method: 'DELETE' })
}
