// 保底 SVG / samed 标记图 overlay 构造（#791 · 上游 autofigure2.py 逐字直译）。
// 上游对照：ResearAI/AutoFigure-Edit @ 16f3749（MIT derivative work，见 NOTICE.md）。
//   create_embedded_figure_svg :3547-3571 · samed 绘制段 :2096-2127 + get_label_font :1416-1446

import type { SamBox } from './values'

// ---------------------------------------------------------------------------
// 保底 SVG（上游 :3547-3571）：内嵌原图 PNG 的最小 SVG——no_icon_mode 且模板重建失败的
// 最终回退，保证工具调用几乎总有可用 SVG 结果（#744 §3.2）。
// ---------------------------------------------------------------------------

export function createEmbeddedFigureSvg(figurePngB64: string, width: number, height: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n` +
    `  <image x="0" y="0" width="${width}" height="${height}" href="data:image/png;base64,${figurePngB64}" preserveAspectRatio="none"/>\n` +
    `</svg>\n`
  )
}

// ---------------------------------------------------------------------------
// samed 标记图 overlay（上游 segment_with_sam3 绘制段直译）：灰框(#808080) + 黑边(3px) +
// 白色居中 label。TS 侧实现 = overlay SVG 字符串构造（纯逻辑，可测）+ sharp composite
//（图像面，FigureImageOpsPort.drawBoxes）。上游用字体渲染文字；overlay SVG 用 <text>
// 声明（渲染宿主差异不改变 LLM 语义输入——灰框位置/label 内容一致）。
// ---------------------------------------------------------------------------

// 字号规则（上游 get_label_font :1435-1437）：box 短边的 1/4，最小 12，最大 48。
export function labelFontSize(boxWidth: number, boxHeight: number): number {
  const minDim = Math.min(boxWidth, boxHeight)
  return Math.max(12, Math.min(48, Math.floor(minDim / 4)))
}

export function samedOverlaySvg(
  width: number,
  height: number,
  boxes: readonly SamBox[],
): string {
  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`)
  for (const box of boxes) {
    const boxWidth = box.x2 - box.x1
    const boxHeight = box.y2 - box.y1
    const fontSize = labelFontSize(boxWidth, boxHeight)
    const cx = Math.floor((box.x1 + box.x2) / 2)
    const cy = Math.floor((box.y1 + box.y2) / 2)
    // PIL draw.rectangle([x1,y1,x2,y2], width=3)：边框以路径为中心，内外各 ~1.5px——
    // SVG rect stroke 居中同语义（x= x1, y= y1, width/height = 右下-左上）。
    parts.push(
      `<rect x="${box.x1}" y="${box.y1}" width="${boxWidth}" height="${boxHeight}" fill="#808080" stroke="black" stroke-width="3"/>`,
    )
    parts.push(
      `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" fill="white" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-weight="bold" font-size="${fontSize}">${box.label.replace('<', '&lt;').replace('>', '&gt;')}</text>`,
    )
  }
  parts.push('</svg>')
  return parts.join('')
}
