// usage API —— admin Usage 核算面（#800 ↔ 后端 /api/v1/usage/aggregate，数据源 #775 采数）。
// wire snake_case；时间窗 [from, to) 半开区间（相邻核算窗拼接不双计边界行，ISO 透传）。
import { apiJson } from '@/api/client'
import { q } from '@/api/queryParams'

export interface UsageAggregateRowDTO {
  user_id: string
  username: string
  provider_id: string
  lc_provider: string
  model: string
  calls: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
}

export function aggregateUsage(query: {
  userId?: string
  from?: Date
  to?: Date
}): Promise<UsageAggregateRowDTO[]> {
  return apiJson<{ items: UsageAggregateRowDTO[] }>(
    `/api/v1/usage/aggregate${q({ userId: query.userId, from: query.from, to: query.to })}`,
  ).then((d) => d.items)
}
