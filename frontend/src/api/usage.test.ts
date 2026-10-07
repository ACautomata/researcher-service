// seam: usage API（#800 admin Usage 核算页 ↔ 后端 /api/v1/usage/aggregate）。
// wire snake_case（对齐 auditRoutes 契约）；时间窗 [from, to) 半开区间透传 ISO。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { aggregateUsage, type UsageAggregateRowDTO } from '@/api/usage'

function mockResp(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  } as unknown as Response
}

const ROW: UsageAggregateRowDTO = {
  user_id: 'u1',
  username: 'alice',
  provider_id: 'p1',
  lc_provider: 'openai',
  model: 'gpt-x',
  calls: 3,
  input_tokens: 100,
  output_tokens: 50,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
}

describe('usage api（#800）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().token = 't'
    vi.stubGlobal('fetch', vi.fn())
  })

  it('aggregateUsage GET /aggregate；过滤与时间窗序列化，缺省省略', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 0, message: 'ok', data: { items: [ROW] } }),
    )
    const out = await aggregateUsage({
      userId: 'u1',
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-10-08T00:00:00Z'),
    })
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toContain('/api/v1/usage/aggregate?')
    expect(path).toContain('userId=u1')
    expect(path).toContain('from=2026-10-01T00%3A00%3A00.000Z')
    expect(path).toContain('to=2026-10-08T00%3A00%3A00.000Z')
    expect(out).toEqual([ROW])
  })

  it('aggregateUsage 全缺省 → 裸路径', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 0, message: 'ok', data: { items: [] } }),
    )
    await aggregateUsage({})
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/usage/aggregate')
  })
})
