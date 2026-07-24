// seam: containers API —— list/create/remove（spec §9.3 容器管理页后端契约）。
// 出处：docs/FULLSTACK-REFACTOR-SPEC.md §9.3（列表 status/health/port + 新建 + 删除）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { createInstance, listInstances, removeInstance } from '@/api/containers'

function mockResp(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response
}

const SAMPLE = {
  name: 'demo',
  port: 19000,
  status: 'running',
  health: 'healthy',
  image: 'img',
  container_id: 'cid',
  created_at: '2026-07-24T00:00:00Z',
}

describe('containers api', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().token = 't'
    vi.stubGlobal('fetch', vi.fn())
  })

  it('listInstances GETs /api/v1/containers/', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp([SAMPLE]))
    const items = await listInstances()
    expect(items).toEqual([SAMPLE])
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/containers/')
  })

  it('createInstance POSTs name body to /api/v1/containers/', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp(SAMPLE, 201))
    const inst = await createInstance('demo')
    expect(inst.name).toBe('demo')
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/containers/')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ name: 'demo' }))
  })

  it('removeInstance DELETEs /api/v1/containers/<name>', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp(null, 204))
    await removeInstance('demo')
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/containers/demo')
    expect(init.method).toBe('DELETE')
  })
})
