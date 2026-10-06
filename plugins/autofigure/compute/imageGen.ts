// MiniMax image-01 生图适配器（#792 · #744 §6：生图 = figure 域面板级配置的服务端出口）。
// API 契约：docs/research/minimax-image01-tokenplan-api.md（官方直连 = TokenPlan 同构）——
// POST {base}/v1/image_generation，请求 {model, prompt, response_format:'base64', n:1}，
// 响应 data.image_base64[]（业务码 base_resp.status_code≠0 = 失败）。
//
// 边界纪律（fal.ts 同型）：凭证构造期注入（面板 env，调用面不透传）；redirect: 'error'；
// 失败归一 throw（graph 节点层定语义——生图失败即 run failed，#744 §3.1）；诊断日志只含
// 固定类别 + HTTP 状态码。PNG 尺寸经 IHDR 头纯逻辑解析（PNG spec：字节 16–23 大端
// width/height）——插件树内零 npm 依赖（autofigureDeps 桥纪律）。

import type { FigureImage, FigureImageGenPort } from './ports'

export type ImageGenFetchImpl = typeof fetch

const IMAGE_GEN_PATH = '/v1/image_generation'

// aspect_ratio 缺省 = 1:1（1024x1024 预设；上游 4K 放大节点在 graph 内，生图侧无需大图）。
export interface MiniMaxImageGenOptions {
  /** 面板 env AUTOFIGURE_IMAGE_API_KEY（服务端凭证，不落盘/不入日志）。 */
  apiKey: string
  /** 面板 env AUTOFIGURE_IMAGE_BASE_URL（缺省国际区 https://api.minimax.io）。 */
  baseUrl?: string
  /** 测试 seam：传输替身（默认全局 fetch）。 */
  fetchImpl?: ImageGenFetchImpl
}

// PNG IHDR 尺寸解析（纯逻辑）：签名 8 字节 + IHDR 长度/类型 8 字节 + width/height 各 4 字节大端。
export function pngIhdrSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  // getUint32 恒有限——只需挡零尺寸（IHDR 全零 = 未渲染占位）。
  if (width === 0 || height === 0) {
    throw new Error('malformed PNG IHDR')
  }
  return { width, height }
}

export class MiniMaxImageGenPort implements FigureImageGenPort {
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly fetchImpl: ImageGenFetchImpl

  constructor(options: MiniMaxImageGenOptions) {
    if (!options.apiKey.trim()) throw new Error('AUTOFIGURE_IMAGE_API_KEY 未配置：生图需要面板级 image key')
    this.endpoint = new URL(IMAGE_GEN_PATH, options.baseUrl ?? 'https://api.minimax.io').toString()
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  async generate(prompt: string, model: string): Promise<FigureImage> {
    let res: Response
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model, prompt, response_format: 'base64', n: 1 }),
        redirect: 'error',
      })
    } catch {
      this.warn('unreachable')
      throw new Error('image generation API unreachable')
    }
    if (!res.ok) {
      this.warn(`non_2xx:${res.status}`)
      throw new Error(`image generation API HTTP ${res.status}`)
    }
    let json: unknown
    try {
      json = await res.json()
    } catch {
      this.warn('malformed_json')
      throw new Error('image generation API malformed JSON')
    }
    const baseResp = (json as { base_resp?: { status_code?: unknown } }).base_resp
    if (typeof baseResp?.status_code === 'number' && baseResp.status_code !== 0) {
      this.warn(`business_error:${baseResp.status_code}`)
      throw new Error(`image generation API error ${baseResp.status_code}`)
    }
    const images = (json as { data?: { image_base64?: unknown } }).data?.image_base64
    const first = Array.isArray(images) && typeof images[0] === 'string' ? images[0] : null
    if (!first) {
      this.warn('missing_image')
      throw new Error('image generation API returned no image')
    }
    const png = new Uint8Array(Buffer.from(first, 'base64'))
    const { width, height } = pngIhdrSize(png)
    return { png, width, height }
  }

  private warn(category: string): void {
    // 诊断日志只含固定类别/状态码，绝不包含凭证、body、raw 响应文本（凭证卫生）
    // eslint-disable-next-line no-console
    console.warn(`[autofigure] image gen: ${category}`)
  }
}
