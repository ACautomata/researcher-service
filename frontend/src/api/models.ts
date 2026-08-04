// models API —— 每容器 model provider CRUD（spec §7 / issue #47）。
// DB 单一来源，写后后端重渲染 openclaw.json 经 watch 热加载生效。apiKey 仅以 env id（marker）
// 形式回读，绝不暴露明文。api 取值 openai-completions / anthropic-messages（r28 §1.3）。
import { apiJson } from '@/api/client'

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

// 集合与详情 URL 都须带尾斜杠，精确匹配后端路由 providers/ 与 providers/<pid>/（CommonMiddleware
// APPEND_SLASH 会把无尾斜杠的 POST 301 到带斜杠 URL，Fetch 随后以 GET 重发 → 创建静默失败）。
function collection(name: string): string {
  return `/api/v1/containers/${encodeURIComponent(name)}/models/providers/`
}

function detail(name: string, pid: string): string {
  return `${collection(name)}${encodeURIComponent(pid)}/`
}

export function listProviders(name: string): Promise<ModelProviderDTO[]> {
  return apiJson<ModelProviderDTO[]>(collection(name))
}

export function createProvider(
  name: string,
  payload: ModelProviderWriteDTO,
): Promise<ModelProviderDTO> {
  return apiJson<ModelProviderDTO>(collection(name), {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateProvider(
  name: string,
  pid: string,
  payload: ModelProviderWriteDTO,
): Promise<ModelProviderDTO> {
  return apiJson<ModelProviderDTO>(detail(name, pid), {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export async function removeProvider(name: string, pid: string): Promise<void> {
  // 经 apiJson：TS 后端越权/不存在删除恒 HTTP 200 + code:20040（同码防探测），旧 apiFetch+resp.ok
  // 把它当成功（PR #370 第四轮 #9 P0）。apiJson 对 code!==0 抛，调用方据 toast 提示失败。
  await apiJson<void>(detail(name, pid), { method: 'DELETE' })
}
