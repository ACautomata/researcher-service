// fal.ai 云 API 适配器（#791 票 2 · #744 §0.3/§5.4/§6：SAM3/RMBG 云计算面）。
// SAM3 请求形状逐字对齐上游 _call_sam3_api（autofigure2.py :1772-1796）；RMBG 走 fal
// Bria RMBG 2.0（#744 §0.3 已核实的云端替代——上游为本地 torch，控制面无重计算面）。
//
// 边界纪律：凭证构造期注入（面板 env FAL_KEY，#744 §6），调用面不透传；redirect: 'error'
//（凭证绝不跟随跨源重定向，对齐 figures/httpPort 先例）；所有失败归一为 throw（graph 节点层
// 决定失败语义——sam3 throw = run failed / rmbg throw = 图标准备降级，#744 §3.1）；
// 诊断日志只含固定类别 + HTTP 状态码，绝不插值响应体/凭证。

import type { FigureRmbgPort, FigureSam3Port } from './ports'
import type { Sam3Detection } from '../pipeline/values'
import { pngToDataUri } from '../pipeline/dataUri'
import { extractFalDetections } from '../pipeline/sam3Parse'

export type FalFetchImpl = typeof fetch

const FAL_SAM3_PATH = '/fal-ai/sam-3/image'
const FAL_RMBG_PATH = '/fal-ai/bria/background/remove'
const FAL_DEFAULT_BASE = 'https://fal.run'

export interface FalAdapterOptions {
  /** fal key（面板 env FAL_KEY；服务端凭证，不落盘/不入日志）。 */
  apiKey: string
  /** 测试 seam：默认 https://fal.run。 */
  baseUrl?: string
  /** 测试 seam：传输替身（默认全局 fetch）。 */
  fetchImpl?: FalFetchImpl
}

abstract class FalEndpoint {
  protected readonly endpoint: string
  protected readonly apiKey: string
  protected readonly fetchImpl: FalFetchImpl

  constructor(options: FalAdapterOptions, path: string, missingKeyMessage: string) {
    if (!options.apiKey.trim()) throw new Error(missingKeyMessage)
    this.endpoint = new URL(path, options.baseUrl ?? FAL_DEFAULT_BASE).toString()
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  protected async postJson(payload: unknown, logPrefix: string): Promise<unknown> {
    let res: Response
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Key ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        redirect: 'error',
      })
    } catch {
      this.warn(logPrefix, 'unreachable')
      throw new Error('fal API unreachable')
    }
    if (!res.ok) {
      this.warn(logPrefix, `non_2xx:${res.status}`)
      throw new Error(`fal API HTTP ${res.status}`)
    }
    try {
      return await res.json()
    } catch {
      this.warn(logPrefix, 'malformed_json')
      throw new Error('fal API malformed JSON')
    }
  }

  protected warn(logPrefix: string, category: string): void {
    // 诊断日志只含固定类别/状态码，绝不包含凭证、body、raw 响应文本（凭证卫生）
    // eslint-disable-next-line no-console
    console.warn(`[autofigure] ${logPrefix}: ${category}`)
  }
}

export class FalSam3Port extends FalEndpoint implements FigureSam3Port {
  constructor(options: FalAdapterOptions) {
    super(options, FAL_SAM3_PATH, 'FAL_KEY 未配置：SAM3 云分割需要 fal key')
  }

  async segment(
    imageDataUri: string,
    prompt: string,
    maxMasks: number,
    imageWidth: number,
    imageHeight: number,
  ): Promise<Sam3Detection[]> {
    // 上游 payload 逐字对齐（:1784-1792）；maxMasks 钳 1..32（上游 :1994）
    const clamped = Math.max(1, Math.min(32, Math.trunc(maxMasks)))
    const payload = {
      image_url: imageDataUri,
      prompt,
      apply_mask: false,
      return_multiple_masks: true,
      max_masks: clamped,
      include_scores: true,
      include_boxes: true,
    }
    const json = await this.postJson(payload, 'sam3 fal failed')
    // 上游 result dict 含 error → raise（:1793-1795）
    if (typeof json === 'object' && json !== null && 'error' in json) {
      this.warn('sam3 fal failed', 'error_field')
      throw new Error('SAM3 fal API error')
    }
    return extractFalDetections(json, imageWidth, imageHeight)
  }
}

export class FalRmbgPort extends FalEndpoint implements FigureRmbgPort {
  constructor(options: FalAdapterOptions) {
    super(options, FAL_RMBG_PATH, 'FAL_KEY 未配置：RMBG 去背景需要 fal key')
  }

  async removeBackground(cropPng: Uint8Array): Promise<Uint8Array> {
    const dataUri = pngToDataUri(cropPng)
    // fal bria background/remove：{image_url} 入，{image: {url}} 出（fal 内容端点统一形状）；
    // 产物图 URL 再拉字节（fal CDN 同源）。
    const json = await this.postJson({ image_url: dataUri }, 'rmbg fal failed')
    let imageUrl: unknown
    if (typeof json === 'object' && json !== null) {
      imageUrl = (json as { image?: { url?: unknown } }).image?.url
    }
    if (typeof imageUrl !== 'string' || !imageUrl) {
      this.warn('rmbg fal failed', 'missing_image_url')
      throw new Error('fal RMBG response missing image url')
    }
    let res: Response
    try {
      res = await this.fetchImpl(imageUrl, { redirect: 'error' })
    } catch {
      this.warn('rmbg fal failed', 'artifact_unreachable')
      throw new Error('fal RMBG artifact unreachable')
    }
    if (!res.ok) {
      this.warn('rmbg fal failed', `artifact_non_2xx:${res.status}`)
      throw new Error(`fal RMBG artifact HTTP ${res.status}`)
    }
    return new Uint8Array(await res.arrayBuffer())
  }
}
