// AutoFigure SVG 工具（#791 · S2 纯逻辑单测）：extract_svg_code 三级提取链 /
// validate_svg_syntax（@xmldom） / get_svg_dimensions / calculate_scale_factors /
// count·validate_base64_images。

import { describe, it, expect } from 'vitest'
import {
  extractSvgCode,
  validateSvgSyntax,
  countBase64Images,
  validateBase64Images,
} from '../../plugins/autofigure/pipeline/svgExtract'
import { getSvgDimensions, calculateScaleFactors } from '../../plugins/autofigure/pipeline/svgDims'

describe('extractSvgCode（上游 :2484-2501 三级链）', () => {
  it('内联 <svg>...</svg>（大小写不敏感）', () => {
    expect(extractSvgCode('before <svg A>1</svg> after')).toBe('<svg A>1</svg>')
    expect(extractSvgCode('<SVG D>4</SVG>')).toBe('<SVG D>4</SVG>')
  })
  it('```svg 围栏', () => {
    expect(extractSvgCode('```svg\n<svg B>2</svg>\n```')).toBe('<svg B>2</svg>')
    expect(extractSvgCode('```xml\n<svg B>2</svg>\n```')).toBe('<svg B>2</svg>')
  })
  it('全文即 SVG', () => {
    expect(extractSvgCode('  <svg C>3</svg>')).toBe('<svg C>3</svg>')
  })
  it('无 SVG → null', () => {
    expect(extractSvgCode('no svg here')).toBeNull()
  })
})

describe('validateSvgSyntax（XML well-formed 门，lxml 语义）', () => {
  it('良构 SVG → valid', () => {
    expect(validateSvgSyntax('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')).toEqual({
      valid: true,
      errors: [],
    })
  })
  it('非良构 → invalid + 错误消息（未闭合标签）', () => {
    const result = validateSvgSyntax('<svg><rect></svg>')
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })
  it('未闭合属性值 → invalid', () => {
    expect(validateSvgSyntax('<svg><rect x="1"</svg>').valid).toBe(false)
  })
})

describe('getSvgDimensions（viewBox 优先 → width/height 回退）', () => {
  it('viewBox 优先', () => {
    expect(getSvgDimensions('<svg viewBox="0 0 200 120" width="400" height="240"/>')).toEqual([200, 120])
  })
  it('无 viewBox → width/height 属性（前导数字）', () => {
    expect(getSvgDimensions('<svg width="640.5px" height="480px"/>')).toEqual([640.5, 480])
  })
  it('都不可得 → null,null', () => {
    expect(getSvgDimensions('<svg><rect/></svg>')).toEqual([null, null])
  })
})

describe('calculateScaleFactors', () => {
  it('SVG 坐标 / 原图像素', () => {
    expect(calculateScaleFactors(200, 120, 400.0, 240.0)).toEqual([2.0, 2.0])
  })
})

describe('base64 图片计数 / 校验（上游 :2922-2944）', () => {
  const B64_SVG =
    '<svg><image href="data:image/png;base64,' + 'QUJD'.repeat(40) + '"/>' +
    '<image xlink:href="data:image/jpeg;base64,' + 'WQ=='.repeat(50) + '"/></svg>'

  it('计数两处 href 形态', () => {
    expect(countBase64Images(B64_SVG)).toBe(2)
  })
  it('足量 + 长度合法 → valid', () => {
    const r = validateBase64Images(B64_SVG, 2)
    expect(r.valid).toBe(true)
    expect(r.message).toContain('2 张图片')
  })
  it('数量不足 → invalid', () => {
    expect(validateBase64Images(B64_SVG, 3).valid).toBe(false)
  })
  it('截断 base64（长度非 4 倍数）→ invalid', () => {
    const truncated = '<svg><image href="data:image/png;base64,QUJDQ"/></svg>'
    expect(validateBase64Images(truncated, 1).valid).toBe(false)
  })
  it('过短 base64（<100）→ invalid', () => {
    const short = '<svg><image href="data:image/png;base64,QUJD"/></svg>'
    expect(validateBase64Images(short, 1).valid).toBe(false)
  })
})
