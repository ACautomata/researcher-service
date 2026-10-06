// SVG 尺寸提取 / 坐标缩放因子（#791 · 上游 autofigure2.py :2653-2700 逐字直译）。
// 上游对照：ResearAI/AutoFigure-Edit @ 16f3749（MIT derivative work，见 NOTICE.md）。

// 从 SVG 代码中提取坐标系尺寸：viewBox 优先（parts[2]/parts[3]），回退 width/height 属性
//（前导数字）。都不可得 → [null, null]。
export function getSvgDimensions(svgCode: string): [number | null, number | null] {
  const viewboxPattern = /viewBox=["']([^"']+)["']/i
  const viewboxMatch = viewboxPattern.exec(svgCode)

  if (viewboxMatch) {
    const viewboxValue = viewboxMatch[1].trim()
    const parts = viewboxValue.split(/\s+/)
    if (parts.length >= 4) {
      const vbWidth = pyFloatLoose(parts[2])
      const vbHeight = pyFloatLoose(parts[3])
      if (vbWidth !== null && vbHeight !== null) return [vbWidth, vbHeight]
    }
  }

  const width = parseDimension(svgCode, 'width')
  const height = parseDimension(svgCode, 'height')
  // Python truthy check（`if width and height`）：null/0 均落 (null, null)。
  if (width && height) return [width, height]
  return [null, null]
}

function pyFloatLoose(value: string): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// 上游 parse_dimension（:2669-2680）：attr 值的前导数字段（[\d.]+）转 float。
function parseDimension(svgCode: string, attrName: string): number | null {
  const pattern = new RegExp(`${attrName}=["']([^"']+)["']`, 'i')
  const match = pattern.exec(svgCode)
  if (match) {
    const value = match[1].trim()
    const numericMatch = /^([\d.]+)/.exec(value)
    if (numericMatch) {
      const n = Number(numericMatch[1])
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

// figure.png 像素坐标 → SVG 坐标的缩放因子（上游 :2691-2700）。
export function calculateScaleFactors(
  figureWidth: number,
  figureHeight: number,
  svgWidth: number,
  svgHeight: number,
): [number, number] {
  return [svgWidth / figureWidth, svgHeight / figureHeight]
}
