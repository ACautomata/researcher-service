// seam: wiki API client —— issue #45 前端数据层（spec §6）。
// 覆盖：tree/page CRUD/graph 的 URL 拼接、method、body、path query 编码。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  createPage,
  deletePage,
  getGraph,
  getTree,
  readPage,
  updatePage,
} from '@/api/wiki'

function mockResp(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response
}

describe('wiki api client', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn())
  })

  function lastCall(): [string, RequestInit] {
    const m = globalThis.fetch as ReturnType<typeof vi.fn>
    return [m.mock.calls[0][0] as string, (m.mock.calls[0][1] ?? {}) as RequestInit]
  }

  it('getTree hits container wiki tree endpoint', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({ groups: [] }))
    await getTree('demo')
    expect(lastCall()[0]).toBe('/api/v1/containers/demo/wiki/tree')
  })

  it('readPage encodes path as query', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({}))
    await readPage('demo', 'domains/cv/papers/resnet.md')
    expect(lastCall()[0]).toBe(
      '/api/v1/containers/demo/wiki/page?path=domains%2Fcv%2Fpapers%2Fresnet.md',
    )
  })

  it('updatePage PUTs path+content', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({}))
    await updatePage('demo', 'concepts/a.md', '# hi')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/containers/demo/wiki/page')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ path: 'concepts/a.md', content: '# hi' })
  })

  it('createPage POSTs path+content', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({}, 201))
    await createPage('demo', 'concepts/b.md', 'x')
    const [, init] = lastCall()
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ path: 'concepts/b.md', content: 'x' })
  })

  it('deletePage DELETEs with path query, tolerates 404', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({}, 204))
    await deletePage('demo', 'concepts/a.md')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/containers/demo/wiki/page?path=concepts%2Fa.md')
    expect(init.method).toBe('DELETE')
  })

  it('getGraph hits graph endpoint', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({ nodes: [], edges: [] }))
    await getGraph('demo')
    expect(lastCall()[0]).toBe('/api/v1/containers/demo/wiki/graph')
  })
})
