// models API —— 每容器 model provider CRUD（spec §7 / issue #47）。
// DB 单一来源，写后后端重渲染 openclaw.json 经 watch 热加载生效。apiKey 仅以 env id（marker）
// 形式回读，绝不暴露明文。api 取值 openai-completions / anthropic-messages（r28 §1.3）。
import { apiFetch, apiJson, ApiError } from '@/api/client'

// r28 §1.3：CRUD 只暴露这两个稳定取值（避免低置信别名）
export type ModelApi = 'openai-completions' | 'anthropic-messages'

export interface ModelEntryDTO {
  id: string
  name?: string
  reasoning?: boolean
  input?: string[]
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow?: number
  maxTokens?: number
}

export interface ModelProviderDTO {
  id: number
  provider_id: string
  api: ModelApi
  base_url: string
  api_key_env_id: string
  auth_header: boolean
  models: ModelEntryDTO[]
  created_at: string
}

export interface ModelProviderWriteDTO {
  provider_id: string
  api: ModelApi
  base_url: string
  api_key_env_id: string
  auth_header: boolean
  models: ModelEntryDTO[]
}

function base(name: string): string {
  return `/api/v1/containers/${encodeURIComponent(name)}/models/providers`
}

export function listProviders(name: string): Promise<ModelProviderDTO[]> {
  return apiJson<ModelProviderDTO[]>(base(name))
}

export function createProvider(
  name: string,
  payload: ModelProviderWriteDTO,
): Promise<ModelProviderDTO> {
  return apiJson<ModelProviderDTO>(base(name), {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateProvider(
  name: string,
  pid: string,
  payload: ModelProviderWriteDTO,
): Promise<ModelProviderDTO> {
  return apiJson<ModelProviderDTO>(`${base(name)}/${encodeURIComponent(pid)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export async function removeProvider(name: string, pid: string): Promise<void> {
  // 删除幂等：404（他人刚删）不报错
  const resp = await apiFetch(`${base(name)}/${encodeURIComponent(pid)}`, {
    method: 'DELETE',
  })
  if (!resp.ok && resp.status !== 404) {
    throw new ApiError(resp.status, '删除失败')
  }
}
