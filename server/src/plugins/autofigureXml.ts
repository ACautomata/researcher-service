// AutoFigure SVG 语法校验（#791 · 上游 validate_svg_syntax :2508-2533 的 TS 实现宿主）。
// 落位说明：@xmldom/xmldom 是 server/package.json 依赖——裸包 import 的文件必须物理位于
// server/ 目录树内（node_modules 从文件位置向上解析；plugins/ 源目录不在 server/node_modules
// 祖先链上）。plugins/autofigure/pipeline/svgExtract.ts 经本桥 re-export（#788 plugins → server
// 源目录直引同向）。
//
// 语义对齐 lxml etree.fromstring：只保证 XML well-formedness（非 DTD/schema 校验）。
// 错误消息格式与 lxml 不同（parser 差异）——消息只进 fix prompt 的 SYNTAX ERRORS DETECTED 段
//（LLM 消费，非结构化契约）；golden 对照注入固定 errors 规避本差异。
// application/xml mimeType 下 xmldom 对 fatal error（非良构）默认抛出（实测钉定）。

export interface SvgSyntaxResult {
  readonly valid: boolean
  readonly errors: readonly string[]
}

import { DOMParser } from '@xmldom/xmldom'

export function validateSvgSyntax(svgCode: string): SvgSyntaxResult {
  try {
    new DOMParser().parseFromString(svgCode, 'application/xml')
    return { valid: true, errors: [] }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { valid: false, errors: [message] }
  }
}
