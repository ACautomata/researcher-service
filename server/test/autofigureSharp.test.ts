// sharp 生产适配器真跑单测（#791 票 2 · 本地库，小 fixture）：裁切 / 4K 放大 /
// samed 标记合成 / 尺寸读取 / SVG→PNG 渲染（含失败归 null）。

import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { SharpImageOpsPort, SharpRenderPort } from '../src/plugins/autofigureSharp'

async function makePng(width: number, height: number, color = '#808080'): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: color },
  })
    .png()
    .toBuffer()
  return new Uint8Array(buf)
}

describe('SharpImageOpsPort（真跑）', () => {
  it('crop：像素矩形裁切', async () => {
    const ops = new SharpImageOpsPort()
    const png = await makePng(8, 6)
    const out = await ops.crop(png, { x1: 2, y1: 1, x2: 6, y2: 5 })
    const meta = await sharp(Buffer.from(out)).metadata()
    expect(meta.width).toBe(4)
    expect(meta.height).toBe(4)
  })

  it('upscaleTo4k：长边不足 → 等比放大到目标；已达 → no-op', async () => {
    const ops = new SharpImageOpsPort()
    const small = await makePng(8, 4)
    const { png, upscaled } = await ops.upscaleTo4k(small, 32)
    expect(upscaled).toBe(true)
    const meta = await sharp(Buffer.from(png)).metadata()
    // scale = 32/8 = 4 → (32, 16)
    expect(meta.width).toBe(32)
    expect(meta.height).toBe(16)

    const { upscaled: again } = await ops.upscaleTo4k(png, 32)
    expect(again).toBe(false)
  })

  it('drawBoxes：overlay 合成（灰框 + label 出现在像素面）', async () => {
    const ops = new SharpImageOpsPort()
    const png = await makePng(64, 64, '#ffffff')
    const out = await ops.drawBoxes(png, [
      { id: 0, label: '<AF>01', x1: 8, y1: 8, x2: 40, y2: 40, score: 0.9, prompt: 'icon' },
    ])
    // 框内出现非白像素（灰 #808080 填充 + 白 label 笔画——合成生效证据；具体像素值
    // 依赖字体渲染，只断言「明显异于纯白底」）
    const raw = await sharp(Buffer.from(out))
      .extract({ left: 8, top: 8, width: 32, height: 32 })
      .raw()
      .toBuffer({ resolveWithObject: true })
    const pixels = raw.data
    let nonWhite = 0
    for (let i = 0; i < pixels.length; i += raw.info.channels) {
      const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]]
      if (r < 200 || g < 200 || b < 200) nonWhite++
    }
    expect(nonWhite).toBeGreaterThan(pixels.length / raw.info.channels / 10) // >10% 框区被 overlay 覆盖
  })

  it('sizeOf：读图像尺寸', async () => {
    const ops = new SharpImageOpsPort()
    const png = await makePng(12, 7)
    expect(await ops.sizeOf(png)).toEqual({ width: 12, height: 7 })
  })
})

describe('SharpRenderPort（真跑）', () => {
  it('SVG → PNG（librsvg 渲染）', async () => {
    const render = new SharpRenderPort()
    const png = await render.svgToPng(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="#ff0000"/></svg>',
      20,
      10,
    )
    expect(png).not.toBeNull()
    const meta = await sharp(Buffer.from(png!)).metadata()
    expect(meta.width).toBe(20)
    expect(meta.height).toBe(10)
  })

  it('渲染失败 → null（不致命语义）', async () => {
    const render = new SharpRenderPort()
    expect(await render.svgToPng('not svg at all <<<', 10, 10)).toBeNull()
  })
})
