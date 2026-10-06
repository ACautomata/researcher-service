// AutoFigure prompt 模板结构断言（#791 · S2）。
// 保真策略：prompt 是逐字移植（#744 §3.3），本文件锁定结构锚点（维度约束 / 占位符 spec /
// 八要点检查单 / 转义三引号形态）；**golden-file 逐字节对照** = testdata/golden/upstream.json
//（采集脚本跑上游 Python 实现生成——需运行外部代码的用户批准，见 plugins/autofigure/testdata/
// README），生成后追加对照断言。错误消息注入面：fix prompt 的 SYNTAX ERRORS DETECTED 内容
// 与 parser 相关（lxml vs @xmldom 消息格式不同），对照场景用固定注入 errors 规避。

import { describe, it, expect } from 'vitest'
import {
  buildImageGenPrompt,
  buildImageGenPromptWithReference,
  buildTemplatePrompt,
  buildFixPrompt,
  buildOptimizePrompt,
  buildOptimizePromptNoIcon,
} from '../../plugins/autofigure/prompts'

const METHOD = 'FlowNet-3 method text.'

describe('生图 prompt（上游 :1345-1374）', () => {
  it('无参考图：academic journal style 锚点 + method 全文内嵌', () => {
    const p = buildImageGenPrompt(METHOD)
    expect(p).toContain('Generate a professional academic journal style figure')
    expect(p).toContain(`below is the method section of this paper:\n\n${METHOD}\n`)
    expect(p).toContain('cute characters')
  })
  it('参考图模式：风格锚点清单 + 三引号字面量包裹 method', () => {
    const p = buildImageGenPromptWithReference(METHOD)
    expect(p).toContain('imitate the visual (artistic) style')
    expect(p).toContain('- typography feel')
    expect(p).toContain(`Below is the method section of the paper:\n"""\n${METHOD}\n"""`)
  })
})

describe('模板 prompt（上游 :2371-2439）', () => {
  const base = { figureWidth: 200, figureHeight: 120, boxlibJson: '{}' }

  it('label 模式：维度硬约束 + #808080 灰底黑框 spec + <g id="AF01"> 结构示例', () => {
    const p = buildTemplatePrompt({ ...base, noIconMode: false, placeholderMode: 'label' })
    expect(p).toContain('viewBox="0 0 200 120"')
    expect(p).toContain('width="200" height="120"')
    expect(p).toContain('DO NOT scale or resize the SVG')
    expect(p).toContain('fill="#808080" and stroke="black" stroke-width="2"')
    expect(p).toContain('<g id="AF01">')
    expect(p).toContain('&lt;AF&gt;01')
    expect(p).not.toContain('ICON COORDINATES')
  })

  it('box 模式：嵌入 boxlib JSON 原文', () => {
    const boxlib = '{"image_size": {"width": 200}}'
    const p = buildTemplatePrompt({ ...base, noIconMode: false, placeholderMode: 'box', boxlibJson: boxlib })
    expect(p).toContain('ICON COORDINATES FROM boxlib.json:')
    expect(p).toContain(boxlib)
    expect(p).not.toContain('PLACEHOLDER STYLE')
  })

  it('none 模式：无占位符段', () => {
    const p = buildTemplatePrompt({ ...base, noIconMode: false, placeholderMode: 'none' })
    expect(p).toContain('output ONLY the SVG code')
    expect(p).not.toContain('PLACEHOLDER STYLE')
    expect(p).not.toContain('ICON COORDINATES')
  })

  it('no_icon 模式：像素级复现 + 禁止占位符（回退链 prompt，#744 §3.2）', () => {
    const p = buildTemplatePrompt({ ...base, noIconMode: true, placeholderMode: 'label' })
    expect(p).toContain('编写 SVG 代码来尽可能像素级复现这张图片')
    expect(p).toContain('不要添加任何灰色矩形占位符')
    expect(p).toContain('Image 2 is the SAM reference image. It does not contain any valid icon placeholder boxes')
    expect(p).not.toContain('编写svg代码来实现像素级别的复现')
  })
})

describe('fix prompt（上游 :2559-2574）', () => {
  it('errors 逐条 "  - " 前缀 + 原文代码块', () => {
    const p = buildFixPrompt('<svg>bad</svg>', ['行 1: mismatched', '行 2: unclosed'])
    expect(p).toContain('SYNTAX ERRORS DETECTED:\n  - 行 1: mismatched\n  - 行 2: unclosed\n')
    expect(p).toContain('```xml\n<svg>bad</svg>\n```')
    expect(p).toContain('Return ONLY the fixed SVG code')
  })
})

describe('optimize prompt（上游 :3054-3113）', () => {
  const SVG = '<svg>cur</svg>'
  it('常规模式：八要点两面向', () => {
    const p = buildOptimizePrompt(SVG)
    expect(p).toContain('TWO MAJOR ASPECTS with EIGHT KEY POINTS')
    expect(p).toContain('## ASPECT 1: POSITION')
    expect(p).toContain('## ASPECT 2: STYLE')
    expect(p).toContain('8. **Lines/Borders (线条)**')
    expect(p).toContain('Keep all icon placeholder structures intact')
    expect(p).toContain(`\`\`\`xml\n${SVG}\n\`\`\``)
  })
  it('no_icon 模式：禁止引入占位框', () => {
    const p = buildOptimizePromptNoIcon(SVG)
    expect(p).toContain('No valid icon boxes were detected')
    expect(p).toContain('Do NOT add gray rectangles, AF labels, placeholder groups, or synthetic icon boxes')
    expect(p).not.toContain('EIGHT KEY POINTS')
  })
})
