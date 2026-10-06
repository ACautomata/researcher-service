// MiniMax image-01 生图适配器契约测试（#792 · 纯逻辑——fetch 全 mock，无真 API 调用）。
// 覆盖：请求形状（endpoint/path、Bearer 头、payload 四键、redirect error）/ 响应解析
//（base64 → PNG 字节 + IHDR 尺寸）/ 错误归一（unreachable、非 2xx、畸形 JSON、业务码≠0、
// 缺图、畸形 IHDR）。凭证纪律断言：Authorization 构造、凭证不进错误消息。
// pngIhdrSize 纯逻辑（IHDR 大端 width/height，插件树零 npm 依赖的尺寸解析面）单列。

import { describe, it, expect, vi } from 'vitest'
import { MiniMaxImageGenPort, pngIhdrSize } from '../../plugins/autofigure/compute/imageGen'

// 4x4 PNG（llmToolPort.test.ts 同物）
const TINY_PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR42mP8z8AAAxIDEwMDAwMDAwAkBgMBjfAPdAAAAAElFTkSuQmCC', 'base64'),
)
const TINY_PNG_B64 = Buffer.from(TINY_PNG).toString('base64')

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('pngIhdrSize（纯逻辑）', () => {
  it('4x4 PNG → {width:4, height:4}', () => {
    expect(pngIhdrSize(TINY_PNG)).toEqual({ width: 4, height: 4 })
  })

  it('IHDR 零尺寸 → throw（未渲染占位）', () => {
    const broken = TINY_PNG.slice()
    new DataView(broken.buffer, broken.byteOffset, broken.byteLength).setUint32(16, 0)
    expect(() => pngIhdrSize(broken)).toThrow('malformed PNG IHDR')
  })

  it('过短输入 → throw（DataView 越界即失败，不静默）', () => {
    expect(() => pngIhdrSize(Uint8Array.from([1, 2, 3]))).toThrow()
  })
})

describe('MiniMaxImageGenPort（契约测试）', () => {
  it('请求形状逐字：POST {base}/v1/image_generation + Bearer + payload 四键 + redirect error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResp(200, { base_resp: { status_code: 0, seq: 1 }, data: { image_base64: [TINY_PNG_B64] } }),
    )
    const port = new MiniMaxImageGenPort({ apiKey: 'k-img', fetchImpl: fetchMock as typeof fetch })

    const out = await port.generate('蛋白质折叠示意图', 'image-01')

    expect(out.png).toEqual(TINY_PNG)
    expect(out.width).toBe(4)
    expect(out.height).toBe(4)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.minimax.io/v1/image_generation')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k-img')
    expect(init.redirect).toBe('error')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'image-01',
      prompt: '蛋白质折叠示意图',
      response_format: 'base64',
      n: 1,
    })
  })

  it('自定义 baseUrl 测试 seam', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResp(200, { base_resp: { status_code: 0 }, data: { image_base64: [TINY_PNG_B64] } }),
    )
    const port = new MiniMaxImageGenPort({
      apiKey: 'k',
      baseUrl: 'https://minimax.example',
      fetchImpl: fetchMock as typeof fetch,
    })
    await port.generate('p', 'image-01')
    expect(fetchMock.mock.calls[0][0]).toBe('https://minimax.example/v1/image_generation')
  })

  it('错误归一：unreachable / 非 2xx / 畸形 JSON / 业务码≠0 / 缺图 / 畸形 IHDR', async () => {
    const netFail = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const p1 = new MiniMaxImageGenPort({ apiKey: 'k', fetchImpl: netFail as typeof fetch })
    await expect(p1.generate('p', 'm')).rejects.toThrow('image generation API unreachable')

    const non2xx = vi.fn().mockResolvedValue(jsonResp(500, {}))
    const p2 = new MiniMaxImageGenPort({ apiKey: 'k', fetchImpl: non2xx as typeof fetch })
    await expect(p2.generate('p', 'm')).rejects.toThrow('image generation API HTTP 500')

    const badJson = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }))
    const p3 = new MiniMaxImageGenPort({ apiKey: 'k', fetchImpl: badJson as typeof fetch })
    await expect(p3.generate('p', 'm')).rejects.toThrow('image generation API malformed JSON')

    const bizErr = vi.fn().mockResolvedValue(jsonResp(200, { base_resp: { status_code: 1004 } }))
    const p4 = new MiniMaxImageGenPort({ apiKey: 'k', fetchImpl: bizErr as typeof fetch })
    await expect(p4.generate('p', 'm')).rejects.toThrow('image generation API error 1004')

    const noImage = vi.fn().mockResolvedValue(jsonResp(200, { base_resp: { status_code: 0 }, data: {} }))
    const p5 = new MiniMaxImageGenPort({ apiKey: 'k', fetchImpl: noImage as typeof fetch })
    await expect(p5.generate('p', 'm')).rejects.toThrow('image generation API returned no image')

    const badIhdr = vi.fn().mockResolvedValue(
      jsonResp(200, { base_resp: { status_code: 0 }, data: { image_base64: [Buffer.from(new Uint8Array(32)).toString('base64')] } }),
    )
    const p6 = new MiniMaxImageGenPort({ apiKey: 'k', fetchImpl: badIhdr as typeof fetch })
    await expect(p6.generate('p', 'm')).rejects.toThrow('malformed PNG IHDR')
  })

  it('业务码 = 0 视为成功（base_resp 存在但 status_code 为 0 不误判失败）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResp(200, { base_resp: { status_code: 0 }, data: { image_base64: [TINY_PNG_B64] } }),
    )
    const port = new MiniMaxImageGenPort({ apiKey: 'k', fetchImpl: fetchMock as typeof fetch })
    await expect(port.generate('p', 'm')).resolves.toMatchObject({ width: 4, height: 4 })
  })

  it('空 key 构造期 fail-fast', () => {
    expect(() => new MiniMaxImageGenPort({ apiKey: '  ' })).toThrow('AUTOFIGURE_IMAGE_API_KEY 未配置')
  })
})
