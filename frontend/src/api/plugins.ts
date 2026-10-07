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
