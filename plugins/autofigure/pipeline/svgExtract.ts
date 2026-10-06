// SVG 提取 / 语法校验 / base64 图片校验（#791 · 上游 autofigure2.py 逐字直译）。
// 上游对照：ResearAI/AutoFigure-Edit @ 16f3749（MIT derivative work，见 NOTICE.md）。
//   extract_svg_code :2484-2501 · validate_svg_syntax :2508-2533（lxml → @xmldom/xmldom）
//   count_base64_images :2922-2926 · validate_base64_images :2929-2944

// ---------------------------------------------------------------------------
// extract_svg_code（上游 :2484-2501 三级提取链，正则逐字保真）
// ---------------------------------------------------------------------------

export function extractSvgCode(content: string): string | null {
  // 1) <svg ...>...</svg> 内联（大小写不敏感）
  const inline = /(<svg[\s\S]*?<\/svg>)/i.exec(content)
  if (inline) return inline[1]

  // 2) ```svg / ```xml 围栏块
  const fenced = /```(?:svg|xml)?\s*([\s\S]*?)```/.exec(content)
  if (fenced) {
    const code = fenced[1].trim()
    if (code.startsWith('<svg')) return code
  }

  // 3) 全文即 SVG
  if (content.trim().startsWith('<svg')) return content.trim()

  return null
}

// ---------------------------------------------------------------------------
// validate_svg_syntax（上游 lxml etree.fromstring 语义 → @xmldom/xmldom XML well-formed 校验）
// ---------------------------------------------------------------------------

// SVG 语法校验实现宿主 = server/src/plugins/autofigureXml.ts（@xmldom/xmldom 是 server 依赖，
// 裸包 import 的文件必须物理位于 server/ 树内——node_modules 从文件位置向上解析；本桥接对齐
// #788 plugins → server 源目录直引同向）。
export { validateSvgSyntax, type SvgSyntaxResult } from '../../../server/src/plugins/autofigureXml'

// ---------------------------------------------------------------------------
// base64 图片计数 / 校验（上游 :2922-2944，正则逐字保真）。
// 现役 graph 配置 skip_base64_validation=True（上游 method_to_svg :3447 同款）不消费本面——
// 保留为计算 Port 换形态资产（skip=false 形态）与 golden 对照面（#744 §3.3 逐字移植纪律）。
// ---------------------------------------------------------------------------

export function countBase64Images(svgCode: string): number {
  const pattern = /(?:href|xlink:href)=["']data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g
  return svgCode.match(pattern)?.length ?? 0
}

export interface Base64Validation {
  readonly valid: boolean
  readonly message: string
}

export function validateBase64Images(svgCode: string, expectedCount: number): Base64Validation {
  const actualCount = countBase64Images(svgCode)
  if (actualCount < expectedCount) {
    return { valid: false, message: `base64 图片数量不足: 期望 ${expectedCount}, 实际 ${actualCount}` }
  }
  const pattern = /data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/g
  for (const match of svgCode.matchAll(pattern)) {
    const b64 = match[1]
    if (b64.length % 4 !== 0) {
      return { valid: false, message: `发现截断的 base64 数据（长度 ${b64.length} 不是 4 的倍数）` }
    }
    if (b64.length < 100) {
      return { valid: false, message: `发现过短的 base64 数据（长度 ${b64.length}），可能被截断` }
    }
  }
  return { valid: true, message: `base64 图片验证通过: ${actualCount} 张图片` }
}
