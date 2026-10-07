// models API —— 每用户（owner 级，#857）model provider CRUD（spec §7 / issue #47）。
// DB 单一来源，写后经 config_meta version bump 热生效（#775；openclaw.json 写盘链已随 T0 #801 退役）。
// owner 直取认证身份——调用方不传容器名（models 域与容器行脱钩）。apiKey 仅以 env id（marker）
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

// #857：owner 级集合/详情面（Express 非 strict 路由，尾斜杠宽容；pid 经 encodeURIComponent
// 防路径分隔符注入）。
const COLLECTION = '/api/v1/models/providers'

function detail(pid: string): string {
  return `${COLLECTION}/${encodeURIComponent(pid)}`
}

export function listProviders(): Promise<ModelProviderDTO[]> {
  return apiJson<ModelProviderDTO[]>(COLLECTION)
}

export function createProvider(payload: ModelProviderWriteDTO): Promise<ModelProviderDTO> {
  return apiJson<ModelProviderDTO>(COLLECTION, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateProvider(
  pid: string,
  payload: ModelProviderWriteDTO,
): Promise<ModelProviderDTO> {
  return apiJson<ModelProviderDTO>(detail(pid), {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export async function removeProvider(pid: string): Promise<void> {
  // 经 apiJson：TS 后端越权/不存在删除恒 HTTP 200 + code:40040（同码防探测），旧 apiFetch+resp.ok
  // 把它当成功（PR #370 第四轮 #9 P0）。apiJson 对 code!==0 抛，调用方据 toast 提示失败。
  await apiJson<void>(detail(pid), { method: 'DELETE' })
}
