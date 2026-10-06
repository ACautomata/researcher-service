// seam: provider endpoints API（#800 admin 白名单管理页 ↔ 后端 /api/v1/provider-endpoints，#775）。
// wire 契约 snake_case（对齐后端 ProviderEndpointView）；CRUD 三操作 URL/方法/体形状锁定。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import {
  createProviderEndpoint,
  listProviderEndpoints,
  removeProviderEndpoint,
  type ProviderEndpointDTO,
} from '@/api/providerEndpoints'

function mockResp(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  } as unknown as Response
}

describe('providerEndpoints api（#800）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().token = 't'
    vi.stubGlobal('fetch', vi.fn())
  })

  it('listProviderEndpoints GETs collection with trailing slash', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp([]))
    await listProviderEndpoints()
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/provider-endpoints/')
  })

  it('createProviderEndpoint POSTs {scheme, host, port?, note?}', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ id: 'e1', scheme: 'https', host: 'api.x.com', port: null, note: '', created_by: 'u1', created_at: '2026-10-07T00:00:00Z' }),
    )
    await createProviderEndpoint({ scheme: 'https', host: 'api.x.com', note: '主站' })
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/provider-endpoints/')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ scheme: 'https', host: 'api.x.com', note: '主站' })
  })

  it('removeProviderEndpoint DELETEs detail URL', async () => {
    // 后端 ep.delete 实返 200 + ok(res, null) 信封（非 204）——mock 对齐真实 wire
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 0, message: 'ok', data: null }),
    )
    await removeProviderEndpoint('e1')
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/provider-endpoints/e1')
    expect(init.method).toBe('DELETE')
  })

  it('wire DTO snake_case 透传（list）', async () => {
    const row: ProviderEndpointDTO = {
      id: 'e1',
      scheme: 'https',
      host: 'api.x.com',
      port: 8443,
      note: 'n',
      created_by: 'u1',
      created_at: '2026-10-07T00:00:00Z',
    }
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 0, message: 'ok', data: [row] }),
    )
    const out = await listProviderEndpoints()
    expect(out).toEqual([row])
  })
})
