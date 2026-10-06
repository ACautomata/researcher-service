// usage API —— admin Usage 核算面（#800 ↔ 后端 /api/v1/usage/aggregate，数据源 #775 采数）。
// wire snake_case；时间窗 [from, to) 半开区间（相邻核算窗拼接不双计边界行，ISO 透传）。
import { apiJson } from '@/api/client'

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
  const usp = new URLSearchParams()
  if (query.userId) usp.set('userId', query.userId)
  if (query.from) usp.set('from', query.from.toISOString())
  if (query.to) usp.set('to', query.to.toISOString())
  const s = usp.toString()
  return apiJson<{ items: UsageAggregateRowDTO[] }>(`/api/v1/usage/aggregate${s ? `?${s}` : ''}`).then(
    (d) => d.items,
  )
}
