// seam: models API —— URL 契约（#857 owner 级；#881 预设制换形：presets/platform 只读面 +
// BYOK CRUD；pid 经 encodeURIComponent 防路径分隔符注入）。Express 非 strict 路由（尾斜杠宽容）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import {
  createProvider,
  getPlatformEndpoint,
  listPresets,
  listProviders,
  removeProvider,
  testConnection,
  updateProvider,
} from '@/api/models'

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
  preset_id: 'openai',
  api_key: 'sk-plain-plaintext',
  models: [{ id: 'g', name: 'G' }],
}

describe('models api URLs（#857 owner 级 + #881 预设制）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().token = 't'
    vi.stubGlobal('fetch', vi.fn())
  })

  it('listPresets GETs the preset catalog', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp([]))
    await listPresets()
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/models/presets')
  })

  it('getPlatformEndpoint GETs the platform read-only card', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({}))
    await getPlatformEndpoint()
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/models/platform')
  })

  it('listProviders GETs the owner-level collection', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp([]))
    await listProviders()
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/models/providers')
  })

  it('createProvider POSTs preset-shaped payload (no base_url field)', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({}, 201))
    await createProvider(PAYLOAD)
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/models/providers')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body) as Record<string, unknown>
    expect(body.preset_id).toBe('openai')
    expect(body.api_key).toBe('sk-plain-plaintext') // 明文只在写请求出现
    expect('base_url' in body).toBe(false)
  })

  it('updateProvider PUTs to the owner-level detail URL; empty api_key omitted (keep-unchanged)', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({}))
    await updateProvider('my-openai', { provider_id: 'my-openai', preset_id: 'kimi', models: [{ id: 'k' }] })
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/models/providers/my-openai')
    expect(init.method).toBe('PUT')
    const body = JSON.parse(init.body) as Record<string, unknown>
    expect('api_key' in body).toBe(false) // 留空 = 保持不变（不发送字段）
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

  it('testConnection POSTs the form state to /models/test（#882 试连）', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp({ ok: true, latency_ms: 1234 }))
    const result = await testConnection({ preset_id: 'openai', api_key: 'sk-plain', model: 'gpt-5.1' })
    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/models/test')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ preset_id: 'openai', api_key: 'sk-plain', model: 'gpt-5.1' })
    expect(result).toEqual({ ok: true, latency_ms: 1234 })
  })

  it('testConnection throws ApiError(90003) on probe failure（净化错误文本）', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 90003, message: 'Error 401: Incorrect API key [REDACTED]', data: null }),
    )
    await expect(testConnection({ preset_id: 'openai', model: 'gpt-5.1' })).rejects.toMatchObject({ code: 90003 })
  })
})
