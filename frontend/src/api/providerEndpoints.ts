// provider endpoints API —— admin 端点白名单管理面（#800 ↔ 后端 /api/v1/provider-endpoints，#775）。
// wire snake_case（对齐后端 ProviderEndpointView）；错误面 ApiError（40041 冲突 / 40040 不存在 /
// 10004 非 admin / 90002 字段级，见后端 models/endpoints.ts）。
import { apiJson } from '@/api/client'

export interface ProviderEndpointDTO {
  id: string
  scheme: string // 'https'（生产）| 'http'（限开发）
  host: string
  port: number | null // NULL = scheme 默认端口
  note: string
  created_by: string
  created_at: string
}

export function listProviderEndpoints(): Promise<ProviderEndpointDTO[]> {
  return apiJson<ProviderEndpointDTO[]>('/api/v1/provider-endpoints/')
}

export function createProviderEndpoint(input: {
  scheme: string
  host: string
  port?: number
  note?: string
}): Promise<ProviderEndpointDTO> {
  return apiJson<ProviderEndpointDTO>('/api/v1/provider-endpoints/', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function removeProviderEndpoint(id: string): Promise<null> {
  // 裸 DELETE 无 body（对齐全仓惯例：containers/models/sessions/wiki 的 DELETE 均不带体）
  return apiJson<null>(`/api/v1/provider-endpoints/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}
