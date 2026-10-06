// seam: figures API —— AutoFigure 域 REST 读面投影（#791 · #744 v2 §7/§8 收缩后形状）。
// 契约对齐后端 figures/routes（读/下载/SVG 面）：#312 信封解包、PNG/SVG 原生响应 vs 信封错误
// 按 Content-Type 判别；创建端点已随 GenerationJob 退役（工具是唯一生成入口），无删除/创建导出。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { ApiError, apiFetch } from '@/api/client'
import {
  getFigureDetail,
  getFigurePngBlob,
  getFigureSvgBlob,
  listFigures,
} from '@/api/figures'

function mockResp(body: unknown, status = 200, contentType = 'application/json'): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
    blob: async () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }),
  } as unknown as Response
}

const SAMPLE = {
  figureId: 'f-1',
  prompt: 'draw a pipeline',
  sessionId: 's-1',
  createdAt: '2026-08-01T00:00:00Z',
}

describe('figures api（读面）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().token = 't'
    vi.stubGlobal('fetch', vi.fn())
  })

  it('listFigures GETs /api/v1/figures and unwraps envelope array', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 0, message: 'ok', data: [SAMPLE] }),
    )
    const items = await listFigures()
    expect(items).toEqual([SAMPLE])
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/figures')
  })

  it('getFigureDetail GETs /api/v1/figures/:id', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({
        code: 0,
        message: 'ok',
        data: { ...SAMPLE, previewReady: true, updatedAt: '2026-08-01T00:01:00Z' },
      }),
    )
    const detail = await getFigureDetail('f-1')
    expect(detail.figureId).toBe('f-1')
    expect(detail.previewReady).toBe(true)
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/figures/f-1')
  })

  it('getFigurePngBlob returns raw Blob for image/png content-type', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp(null, 200, 'image/png'))
    const blob = await getFigurePngBlob('f-1')
    expect(blob).toBeInstanceOf(Blob)
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/figures/f-1/png')
  })

  it('getFigureSvgBlob GETs /:id/svg；download=true 追加 ?download=1', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResp(null, 200, 'image/svg+xml'))
    await getFigureSvgBlob('f-1')
    await getFigureSvgBlob('f-1', true)
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0][0]).toBe('/api/v1/figures/f-1/svg')
    expect(calls[1][0]).toBe('/api/v1/figures/f-1/svg?download=1')
  })

  it('getFigurePngBlob throws ApiError 70043 when artifact unavailable', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 70043, message: 'Figure 产物不可用', data: null }),
    )
    const err = await getFigurePngBlob('f-1').catch((e) => e)
    expect((err as ApiError).code).toBe(70043)
  })

  it('module surface exports no create/delete operation（创建端点退役，工具是唯一生成入口）', async () => {
    const mod = await import('@/api/figures')
    const names = Object.keys(mod)
    expect(names.some((k) => /delete|remove|create/i.test(k))).toBe(false)
  })
})

// Spec-1（二进制 body 守卫）：真实 Response 严格建模 bodyUsed/Content-Type——PNG 成功经 apiFetch
// 后 body 不得被消费（后续 blob() 可用）；getFigurePngBlob 成功 blob() 原生字节；JSON 错误信封保留
// 70040/70043 精确 code；JSON 10001 信封仍触发既有刷新链（auth 行为无回归）。
describe('getFigurePngBlob binary body safety（真实 Response）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().token = 't'
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function realPngResponse(): Response {
    return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    })
  }

  function realEnvResponse(code: number, message: string): Response {
    return new Response(JSON.stringify({ code, message, data: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('image/png 200 经 apiFetch 后 body 未被消费（bodyUsed=false）', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(realPngResponse())
    const resp = await apiFetch('/api/v1/figures/f-1/png')
    expect(resp.headers.get('content-type')).toContain('image/png')
    expect(resp.bodyUsed).toBe(false) // 未读 body —— 后续 resp.blob() 可用
  })

  it('getFigurePngBlob 成功 blob() 原生 PNG 字节', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(realPngResponse())
    const blob = await getFigurePngBlob('f-1')
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(8)
  })

  it('JSON 错误信封保留 70040/70043 精确 code', async () => {
    const cases: Array<[number, string]> = [
      [70043, 'Figure 产物不可用'],
      [70040, 'figure 不存在或无权访问'],
    ]
    for (const [code, message] of cases) {
      ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(realEnvResponse(code, message))
      const err = await getFigurePngBlob('f-1').catch((e) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe(code)
      expect((err as ApiError).message).toBe(message)
    }
  })

  it('auth refresh 无回归：PNG JSON 10001 信封仍触发刷新链并重试成功', async () => {
    const auth = useAuthStore()
    auth.token = 'revoked-access'
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(realEnvResponse(10001, '未认证')) // 原请求：吊销 token → 刷新链
      .mockResolvedValueOnce(mockResp({ access: 'fresh-access' }, 200)) // refresh 成功
      .mockResolvedValueOnce(realPngResponse()) // 重试：新 token → PNG 字节
    const blob = await getFigurePngBlob('f-1')
    expect(blob.type).toBe('image/png')
    expect(auth.token).toBe('fresh-access')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const retryInit = fetchMock.mock.calls[2][1] as RequestInit
    expect((retryInit.headers as Headers).get('Authorization')).toBe('Bearer fresh-access')
  })
})
