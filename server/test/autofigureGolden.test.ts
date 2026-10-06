// AutoFigure golden-file 逐字节对照（#791 · #744 §3.3「移植验收 = 同输入下与上游 Python 实现
// 的产物对照」）。
//
// 采集方法（一次，需运行外部上游代码的用户批准）：/tmp 侧运行
// `python3 dump_golden.py <本目录>/upstream.json`——monkeypatch 上游 LLM 调用面真跑
// AutoFigure-Edit @ 16f3749 的纯函数，dump prompt 文本与纯逻辑输出。golden 文件提交入库。
// 文件不存在时本套件整体 skip（golden 生成后自动激活，不改测试代码）。
//
// 差异豁免面（parser/渲染器差异，golden 采集脚本已规避）：
//   - fix prompt 的 SYNTAX ERRORS DETECTED 段：lxml vs @xmldom 错误消息格式不同——
//     采集脚本注入固定 errors 后对照（本测试用同一注入 errors）；
//   - samed 绘制是栅格渲染（PIL 字体）——golden 只覆盖 overlay 构造的纯逻辑不变量。

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cxcywhNormToXyxy,
  polygonToBbox,
  extractFalDetections,
  extractRoboflowDetections,
  calculateOverlapRatio,
  mergeOverlappingBoxes,
} from '../../plugins/autofigure/pipeline/sam3Parse'
import { getSvgDimensions, calculateScaleFactors } from '../../plugins/autofigure/pipeline/svgDims'
import { countBase64Images, validateBase64Images, extractSvgCode } from '../../plugins/autofigure/pipeline/svgExtract'
import { replaceIconsInSvg } from '../../plugins/autofigure/pipeline/replaceIcons'
import { createEmbeddedFigureSvg } from '../../plugins/autofigure/pipeline/samed'
import {
  buildImageGenPrompt,
  buildImageGenPromptWithReference,
  buildTemplatePrompt,
  buildFixPrompt,
  buildOptimizePrompt,
  buildOptimizePromptNoIcon,
} from '../../plugins/autofigure/prompts'

const GOLDEN_PATH = join(__dirname, '../../plugins/autofigure/testdata/golden/upstream.json')
const hasGolden = existsSync(GOLDEN_PATH)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const golden: any = hasGolden ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) : {}

describe.skipIf(!hasGolden)('golden-file 对照（上游 AutoFigure-Edit @ 16f3749）', () => {
  it('生图 prompt（无参考图 / 有参考图）逐字节对照', () => {
    const method = golden.image_prompt_no_ref.prompt
    expect(buildImageGenPrompt(method)).toBe(golden.image_prompt_no_ref.prompt)
    expect(buildImageGenPromptWithReference(method)).toBe(golden.image_prompt_with_ref.prompt)
    expect(buildImageGenPrompt(method)).toContain(method)
  })

  it('模板 prompt（label/box/no_icon）逐字节对照', () => {
    const method = golden.image_prompt_no_ref.prompt
    void method
    expect(
      buildTemplatePrompt({
        figureWidth: golden.template_prompt_label.figureWidth ?? 200,
        figureHeight: golden.template_prompt_label.figureHeight ?? 120,
        noIconMode: false,
        placeholderMode: 'label',
        boxlibJson: golden.template_prompt_box.boxlibJson ?? '{}',
      }),
    ).toBe(golden.template_prompt_label.prompt)
    // box 模式 golden 带真实 boxlib 嵌入
    if (golden.template_prompt_box.boxlibJson) {
      expect(
        buildTemplatePrompt({
          figureWidth: golden.template_prompt_box.figureWidth ?? 200,
          figureHeight: golden.template_prompt_box.figureHeight ?? 120,
          noIconMode: false,
          placeholderMode: 'box',
          boxlibJson: golden.template_prompt_box.boxlibJson,
        }),
      ).toBe(golden.template_prompt_box.prompt)
    }
    // no_icon 模式 golden 固定尺寸（上游 fixture 200x120）
    expect(
      buildTemplatePrompt({
        figureWidth: golden.template_prompt_no_icon.figureWidth ?? 200,
        figureHeight: golden.template_prompt_no_icon.figureHeight ?? 120,
        noIconMode: true,
        placeholderMode: 'label',
        boxlibJson: '{}',
      }),
    ).toBe(golden.template_prompt_no_icon.prompt)
  })

  it('fix prompt 逐字节对照（固定注入 errors 规避 parser 差异）', () => {
    expect(buildFixPrompt(golden.fix_prompt_bad_svg, golden.fix_prompt_injected_errors)).toBe(
      golden.fix_prompt.prompt,
    )
  })

  it('optimize prompt（常规 / no_icon）逐字节对照', () => {
    expect(buildOptimizePrompt(golden.optimize_prompts_label[0].currentSvg ?? '')).toBe(
      golden.optimize_prompts_label[0].prompt,
    )
    expect(buildOptimizePromptNoIcon(golden.optimize_prompt_no_icon[0].currentSvg ?? '')).toBe(
      golden.optimize_prompt_no_icon[0].prompt,
    )
  })

  it('SAM3 解析（fal metadata / fal boxes / roboflow polygon）逐值对照', () => {
    expect(golden.sam3_fal_metadata.length).toBeGreaterThan(0)
    for (const det of golden.sam3_fal_metadata) {
      expect(cxcywhNormToXyxy(det.box, det.imageW, det.imageH)).toEqual(det.xyxy)
    }
    expect(extractFalDetections(golden.sam3_fal_resp, 200, 120)).toEqual(golden.sam3_fal_detections)
    expect(extractRoboflowDetections(golden.sam3_roboflow_resp, 200, 120)).toEqual(
      golden.sam3_roboflow_detections,
    )
  })

  it('box 合并 / overlap ratio / 缩放因子 / SVG 尺寸 / base64 校验逐值对照', () => {
    for (const c of golden.parity_cases ?? []) {
      if (c.fn === 'overlap') expect(calculateOverlapRatio(c.a, c.b)).toBeCloseTo(c.expected, 10)
      if (c.fn === 'svgDims') expect(getSvgDimensions(c.svg)).toEqual(c.expected)
      if (c.fn === 'scale')
        expect(
          calculateScaleFactors(c.args[0], c.args[1], c.args[2], c.args[3]),
        ).toEqual(c.expected)
      if (c.fn === 'countBase64') expect(countBase64Images(c.svg)).toBe(c.expected)
      if (c.fn === 'validateBase64') {
        // Python tuple → JSON [valid, message] → TS 对象形状
        expect(validateBase64Images(c.svg, c.n)).toEqual({ valid: c.expected[0], message: c.expected[1] })
      }
      if (c.fn === 'polygonToBbox') expect(polygonToBbox(c.points, 200, 120)).toEqual(c.expected)
    }
  })

  it('图标替换 final.svg 逐字节对照（五策略链一网打尽场景）', () => {
    const out = replaceIconsInSvg({
      templateSvg: golden.replace.template,
      iconInfos: golden.replace.icons,
      scaleFactorX: golden.replace.scaleFactors[0],
      scaleFactorY: golden.replace.scaleFactors[1],
      matchByLabel: golden.replace.matchByLabel,
    })
    expect(out).toBe(golden.replace.finalSvg)
  })

  it('保底 embedded SVG 逐字节对照（base64 内嵌 + 尾随换行）', () => {
    const out = createEmbeddedFigureSvg(golden.embedded.b64, golden.embedded.width, golden.embedded.height)
    expect(out).toBe(golden.embedded.svg)
  })

  it('extract_svg_code 各形态对照', () => {
    for (const c of golden.extract_svg ?? []) {
      expect(extractSvgCode(c.input)).toBe(c.expected)
    }
  })

  it('boxlib 构造对照（上游 boxlib_data 字典 JSON 序列化）', () => {
    expect(mergeOverlappingBoxes(golden.merge_boxes.input, golden.merge_boxes.threshold)).toEqual(
      golden.merge_boxes.expected,
    )
  })
})
