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

export interface ArgumentCompletion { value: string; description?: string }

export async function getPluginArgumentCompletions(pluginId: string, name: string, prefix: string): Promise<ArgumentCompletion[]> {
  const query = new URLSearchParams({ prefix })
  const data = await apiJson<{ completions: ArgumentCompletion[] }>(`/api/v1/plugins/${encodeURIComponent(pluginId)}/commands/${encodeURIComponent(name)}/completions?${query}`)
  return data.completions
}
