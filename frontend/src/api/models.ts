// models API —— 每用户（owner 级，#857）LLM 端点 CRUD（#881 预设制换形）。
// DB 单一来源，写后经 config_meta version bump 热生效（#775）。
// 预设制：preset_id 锁定协议与地址（无自由 baseURL 输入）；key 明文单向流——只在写请求
// 出现，读回只有掩码（api_key_masked；key_error = 解密失败标记）；编辑留空 = 保持不变。
// 平台默认端点 = env 派生虚拟实体（GET /platform 只读卡），任何响应无 key 材料。
import { apiJson } from '@/api/client'

// 协议二值（预设派生只读）
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

// 端点预设（六预设目录；建端点下拉的取值域）
export interface EndpointPresetDTO {
  id: string
  name: string
  protocol: ModelApi
  base_url: string
  default_models: ModelEntryDTO[]
}

// 平台默认端点只读卡（永无 key 材料——key_configured 布尔即全部凭证信息面）
export interface PlatformEndpointDTO {
  provider_id: string
  preset_id: string
  protocol: ModelApi
  lc_provider: 'openai' | 'anthropic'
  base_url: string
  default_model: string | null
  key_configured: boolean
}

export interface ModelProviderDTO {
  id: string
  provider_id: string
  preset_id: string
  protocol: ModelApi
  base_url: string
  api_key_masked: string | null
  key_error: boolean
  models: ModelEntryDTO[]
  created_at: string
}

// 写载荷：api_key 缺省/空串语义按操作区分（POST = 用平台共享 key；PUT = 保持不变）。
export interface ModelProviderWriteDTO {
  provider_id: string
  preset_id: string
  api_key?: string
  models: ModelEntryDTO[]
}

const BASE = '/api/v1/models'
const COLLECTION = `${BASE}/providers`

function detail(pid: string): string {
  return `${COLLECTION}/${encodeURIComponent(pid)}`
}

export function listPresets(): Promise<EndpointPresetDTO[]> {
  return apiJson<EndpointPresetDTO[]>(`${BASE}/presets`)
}

export function getPlatformEndpoint(): Promise<PlatformEndpointDTO> {
  return apiJson<PlatformEndpointDTO>(`${BASE}/platform`)
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
  // 经 apiJson：TS 后端越权/不存在删除恒 HTTP 200 + code:40040（同码防探测）。apiJson 对
  // code!==0 抛，调用方据 toast 提示失败。
  await apiJson<void>(detail(pid), { method: 'DELETE' })
}
