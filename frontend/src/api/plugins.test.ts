// seam: 插件 enablement API（#799 · #752 §4.3 R8）——PUT /api/v1/plugins/:id/enablement
// wire 契约：幂等 upsert，body {enabled: boolean}；响应 {id, enabled}。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { setPluginEnablement } from './plugins'

function mockResp(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  } as unknown as Response
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('plugins api enablement（#799）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().token = 't'
    vi.stubGlobal('fetch', vi.fn())
  })

  it('PUT /api/v1/plugins/:id/enablement，body {enabled}', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({ id: 'autofigure', enabled: true }))
    const result = await setPluginEnablement('autofigure', true)
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/plugins/autofigure/enablement')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ enabled: true })
    expect(result).toEqual({ id: 'autofigure', enabled: true })
  })
})
