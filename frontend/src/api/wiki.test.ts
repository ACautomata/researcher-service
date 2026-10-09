// seam: wiki API client —— issue #45 前端数据层（spec §6）。
// #856：owner 级端点 /api/v1/wiki/*（ownerId 直取认证身份），调用方不再传容器名。
// 覆盖：tree/page 读/graph 的 URL 拼接、method、path query 编码（页写面已退役清零）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  getGraph,
  getTree,
  readPage,
} from '@/api/wiki'

// 默认 application/json——后端 #312 信封响应经 res.json() 恒带该头；apiFetch 现按 Content-Type 决定
// 是否做信封 sniff，mock 须建模真实响应头（否则非 JSON 200 会误走「跳过 sniff」分支）。
function mockResp(body: unknown, status = 200, contentType = 'application/json'): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
  } as unknown as Response
}

describe('wiki api client（#856 owner 级）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn())
  })

  function lastCall(): [string, RequestInit] {
    const m = globalThis.fetch as ReturnType<typeof vi.fn>
    return [m.mock.calls[0][0] as string, (m.mock.calls[0][1] ?? {}) as RequestInit]
  }

  it('getTree hits owner-level wiki tree endpoint', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({ groups: [] }))
    await getTree()
    expect(lastCall()[0]).toBe('/api/v1/wiki/tree')
  })

  it('readPage encodes path as query', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({}))
    await readPage('domains/cv/papers/resnet.md')
    expect(lastCall()[0]).toBe(
      '/api/v1/wiki/page?path=domains%2Fcv%2Fpapers%2Fresnet.md',
    )
  })

  it('getGraph hits graph endpoint', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({ nodes: [], edges: [] }))
    await getGraph()
    expect(lastCall()[0]).toBe('/api/v1/wiki/graph')
  })
})
