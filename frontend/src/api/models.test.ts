// seam: models API —— URL 契约（#857 owner 级：/api/v1/models/providers[/<pid>]，owner 直取
// 认证身份，调用方不再传容器名）。Express 非 strict 路由（尾斜杠宽容），无 Django
// APPEND_SLASH 重发陷阱；pid 经 encodeURIComponent 防路径分隔符注入。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { createProvider, listProviders, removeProvider, updateProvider } from '@/api/models'

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

const PAYLOAD = {
  provider_id: 'my-openai',
  api: 'openai-completions' as const,
  base_url: 'https://x/v1',
  api_key_env_id: 'LLM_API_KEY',
  auth_header: true,
  models: [{ id: 'g', name: 'G' }],
}

describe('models api URLs（#857 owner 级）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().token = 't'
    vi.stubGlobal('fetch', vi.fn())
  })

  it('listProviders GETs the owner-level collection', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp([]))
    await listProviders()
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/models/providers')
  })

  it('createProvider POSTs to the owner-level collection', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({}, 201))
    await createProvider(PAYLOAD)
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/models/providers')
    expect(init.method).toBe('POST')
  })

  it('updateProvider PUTs to the owner-level detail URL', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({}))
    await updateProvider('my-openai', PAYLOAD)
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/models/providers/my-openai')
    expect(init.method).toBe('PUT')
  })

  it('removeProvider DELETEs the owner-level detail URL', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp(null, 204))
    await removeProvider('my-openai')
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/models/providers/my-openai')
    expect(init.method).toBe('DELETE')
  })

  // PR #370 第四轮 #9（P0）：TS 后端越权/不存在删除恒 HTTP 200 + code:40040——旧 apiFetch+resp.ok
  // 当成功。改 apiJson 后须对 code!==0 抛。
  it('removeProvider throws ApiError(40040) on envelope forbidden/not-found', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 40040, message: 'provider 不存在或无权访问', data: null }),
    )
    await expect(removeProvider('my-openai')).rejects.toMatchObject({ code: 40040 })
  })

  it('encodes pid path segment', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp(null, 204))
    await removeProvider('a b/c')
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/models/providers/a%20b%2Fc')
  })
})
