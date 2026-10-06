// sharp 生产图像适配器（#791 票 2 · #744 §0.3：裁切/4K 放大 = TS 原生 sharp；SVG→PNG 渲染
// 走 sharp 内置 librsvg——#744 §0.3「resvg-j / sharp（无浏览器路径）」二选一的 sharp 形态）。
// 纯逻辑面（overlay SVG 构造 / 字号规则）在 pipeline/samed.ts——本文件只做图像 IO。

import sharp from 'sharp'
import type {
  FigureImageOpsPort,
  FigureRenderPort,
} from '../../../plugins/autofigure/compute/ports'
import type { SamBox } from '../../../plugins/autofigure/pipeline/values'
import { samedOverlaySvg } from '../../../plugins/autofigure/pipeline/samed'

export class SharpImageOpsPort implements FigureImageOpsPort {
  async crop(
    png: Uint8Array,
    box: { x1: number; y1: number; x2: number; y2: number },
  ): Promise<Uint8Array> {
    const out = await sharp(Buffer.from(png))
      .extract({ left: box.x1, top: box.y1, width: box.x2 - box.x1, height: box.y2 - box.y1 })
      .png()
      .toBuffer()
    return new Uint8Array(out)
  }

  async upscaleTo4k(
    png: Uint8Array,
    targetLongEdge: number,
  ): Promise<{ png: Uint8Array; upscaled: boolean }> {
    const meta = await sharp(Buffer.from(png)).metadata()
    const width = meta.width ?? 0
    const height = meta.height ?? 0
    const longEdge = Math.max(width, height)
    if (longEdge <= 0 || longEdge >= targetLongEdge) {
      return { png, upscaled: false }
    }
    // 等比放大到目标长边（PIL LANCZOS → sharp lanczos3；上游 _upscale_image_to_4k_if_needed）
    const scale = targetLongEdge / longEdge
    const newWidth = Math.max(1, Math.round(width * scale))
    const newHeight = Math.max(1, Math.round(height * scale))
    const out = await sharp(Buffer.from(png))
      .resize(newWidth, newHeight, { kernel: 'lanczos3' })
      .png()
      .toBuffer()
    return { png: new Uint8Array(out), upscaled: true }
  }

  async drawBoxes(png: Uint8Array, boxes: readonly SamBox[]): Promise<Uint8Array> {
    const meta = await sharp(Buffer.from(png)).metadata()
    const overlay = samedOverlaySvg(meta.width ?? 1, meta.height ?? 1, boxes)
    const out = await sharp(Buffer.from(png))
      .composite([{ input: Buffer.from(overlay) }])
      .png()
      .toBuffer()
    return new Uint8Array(out)
  }

  async sizeOf(png: Uint8Array): Promise<{ width: number; height: number }> {
    const meta = await sharp(Buffer.from(png)).metadata()
    return { width: meta.width ?? 0, height: meta.height ?? 0 }
  }
}

export class SharpRenderPort implements FigureRenderPort {
  /** SVG → PNG（librsvg）。失败归 null（渲染不致命——预览缺省 + meta 标记，#744 §3.1）。 */
  async svgToPng(svg: string, width: number, height: number): Promise<Uint8Array | null> {
    try {
      const out = await sharp(Buffer.from(svg), { density: 72 })
        .resize(width, height, { fit: 'fill' })
        .png()
        .toBuffer()
      return new Uint8Array(out)
    } catch {
      return null
    }
  }
}
