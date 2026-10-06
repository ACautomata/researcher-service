// fal 云 API 适配器契约测试（#791 票 2 · S2 纯逻辑——fetch 全 mock，无真 API 调用）。
// 覆盖：SAM3 请求形状（上游 _call_sam3_api :1772-1796 逐字）/ 响应解析（extractFalDetections
// 接线）/ RMBG 请求 + 产物 URL 回拉 / 错误归一（unreachable、非 2xx、error 字段、缺 URL）。
// 凭证纪律断言：Authorization 头构造、redirect: 'error'、凭证不进日志文本面。

import { describe, it, expect, vi } from 'vitest'
import { FalSam3Port, FalRmbgPort } from '../../plugins/autofigure/compute/fal'

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('FalSam3Port（契约测试）', () => {
  it('请求形状逐字对齐上游（payload 八键 + Authorization: Key）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResp(200, { metadata: [{ box: [0.5, 0.5, 0.2, 0.4], score: 0.9 }] }),
    )
    const port = new FalSam3Port({ apiKey: 'k-fal', fetchImpl: fetchMock as typeof fetch })

    await port.segment('data:image/png;base64,AAAA', 'icon', 32, 200, 120)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://fal.run/fal-ai/sam-3/image')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Key k-fal')
    expect(init.redirect).toBe('error')
    const payload = JSON.parse(init.body as string)
    expect(payload).toEqual({
      image_url: 'data:image/png;base64,AAAA',
      prompt: 'icon',
      apply_mask: false,
      return_multiple_masks: true,
      max_masks: 32,
      include_scores: true,
      include_boxes: true,
    })
  })

  it('max_masks 钳 1..32（上游 :1994）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(200, { boxes: [], scores: [] }))
    const port = new FalSam3Port({ apiKey: 'k', fetchImpl: fetchMock as typeof fetch })
    await port.segment('data:image/png;base64,AAAA', 'icon', 999, 100, 100)
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).max_masks).toBe(32)
  })

  it('响应 → detections（尺寸换算接线）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResp(200, { metadata: [{ box: [0.5, 0.5, 0.2, 0.4], score: 0.9 }] }),
    )
    const port = new FalSam3Port({ apiKey: 'k', fetchImpl: fetchMock as typeof fetch })
    const dets = await port.segment('data:image/png;base64,AAAA', 'icon', 32, 200, 120)
    // cx=100 cy=60 bw=40 bh=48 → x1=80 y1=36 x2=120 y2=84
    expect(dets).toEqual([{ x1: 80, y1: 36, x2: 120, y2: 84, score: 0.9 }])
  })

  it('响应含 error 字段 → throw（上游 :1793-1795）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(200, { error: 'bad prompt' }))
    const port = new FalSam3Port({ apiKey: 'k', fetchImpl: fetchMock as typeof fetch })
    await expect(port.segment('d', 'icon', 32, 100, 100)).rejects.toThrow('SAM3 fal API error')
  })

  it('非 2xx / 网络失败 / 畸形 JSON → throw（诊断日志不含凭证响应体）', async () => {
    const non2xx = vi.fn().mockResolvedValue(jsonResp(500, {}))
    const port = new FalSam3Port({ apiKey: 'k', fetchImpl: non2xx as typeof fetch })
    await expect(port.segment('d', 'icon', 32, 100, 100)).rejects.toThrow('fal API HTTP 500')

    const netFail = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const port2 = new FalSam3Port({ apiKey: 'k', fetchImpl: netFail as typeof fetch })
    await expect(port2.segment('d', 'icon', 32, 100, 100)).rejects.toThrow('fal API unreachable')

    const badJson = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }))
    const port3 = new FalSam3Port({ apiKey: 'k', fetchImpl: badJson as typeof fetch })
    await expect(port3.segment('d', 'icon', 32, 100, 100)).rejects.toThrow('malformed JSON')
  })

  it('空 key 构造期 fail-fast', () => {
    expect(() => new FalSam3Port({ apiKey: '  ' })).toThrow('FAL_KEY 未配置')
  })

  it('自定义 baseUrl 测试 seam', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(200, { boxes: [], scores: [] }))
    const port = new FalSam3Port({
      apiKey: 'k',
      baseUrl: 'https://fal.example',
      fetchImpl: fetchMock as typeof fetch,
    })
    await port.segment('d', 'icon', 32, 100, 100)
    expect((fetchMock.mock.calls[0][0] as string).startsWith('https://fal.example/fal-ai/sam-3/image')).toBe(true)
  })
})

describe('FalRmbgPort（契约测试）', () => {
  it('请求 {image_url} + 产物 URL 回拉字节', async () => {
    const artifact = new Uint8Array([1, 2, 3, 4])
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResp(200, { image: { url: 'https://cdn.fal.example/a.png' } }),
      )
      .mockResolvedValueOnce(
        new Response(artifact, { status: 200, headers: { 'Content-Type': 'image/png' } }),
      )
    const port = new FalRmbgPort({ apiKey: 'k', fetchImpl: fetchMock as typeof fetch })

    const out = await port.removeBackground(new Uint8Array([9, 9]))

    expect(out).toEqual(new Uint8Array([1, 2, 3, 4]))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://fal.run/fal-ai/bria/background/remove')
    expect((init.headers as Record<string, string>).Authorization).toBe('Key k')
    expect(JSON.parse(init.body as string).image_url).toBe('data:image/png;base64,CQk=')
  })

  it('响应缺 image.url → throw', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(200, {}))
    const port = new FalRmbgPort({ apiKey: 'k', fetchImpl: fetchMock as typeof fetch })
    await expect(port.removeBackground(new Uint8Array([1]))).rejects.toThrow('missing image url')
  })

  it('产物回拉失败 → throw', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResp(200, { image: { url: 'https://cdn/x.png' } }))
      .mockResolvedValueOnce(new Response('gone', { status: 404 }))
    const port = new FalRmbgPort({ apiKey: 'k', fetchImpl: fetchMock as typeof fetch })
    await expect(port.removeBackground(new Uint8Array([1]))).rejects.toThrow('HTTP 404')
  })
})
