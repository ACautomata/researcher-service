// AutoFigure 图标替换策略链 / 保底 SVG / samed overlay（#791 · S2 纯逻辑 + S4 行为快照）。
// 上游对照：replace_icons_in_svg :2707-2915 · create_embedded_figure_svg :3547-3571。
// golden-file 升级位：testdata/golden/upstream.json 生成后（需运行上游采集脚本的用户批准，
// 见 dump_golden.py）追加逐字节对照断言；本文件先以确定性快照锁定移植行为。

import { describe, it, expect } from 'vitest'
import { replaceIconsInSvg } from '../../plugins/autofigure/pipeline/replaceIcons'
import { createEmbeddedFigureSvg, labelFontSize, samedOverlaySvg } from '../../plugins/autofigure/pipeline/samed'

const ICON_B64 = 'aWNvbg==' // 任意确定性 base64（匹配面只关心 data: 前缀形状）

function icon(label: string, x1: number, y1: number, width: number, height: number) {
  return { label, labelClean: label.replace(/<|>/g, ''), x1, y1, width, height, nobgPngB64: ICON_B64 }
}

describe('replaceIconsInSvg 策略链', () => {
  it('方式 1：<g id="AF01"> 整组替换（transform translate 坐标合并）', () => {
    const template =
      '<svg width="100"><g id="AF01" transform="translate(5, 5)"><rect x="5" y="0" width="60" height="40" fill="#808080" stroke="black"/></g></svg>'
    const out = replaceIconsInSvg({
      templateSvg: template,
      iconInfos: [icon('<AF>01', 10, 5, 60, 40)],
      scaleFactorX: 1,
      scaleFactorY: 1,
      matchByLabel: true,
    })
    // translate(5,5) + rect(5,0) = (10,5)——Python float repr 整数带 .0
    expect(out).toContain('<image id="icon_AF01" x="10.0" y="5.0" width="60.0" height="40.0"')
    expect(out).toContain(`href="data:image/png;base64,${ICON_B64}"`)
    expect(out).not.toContain('<g id="AF01"')
  })

  it('方式 2：<text> 邻近（前向最近）<rect> 替换 + text 删除', () => {
    const template =
      '<svg><rect x="0" y="0" width="10" height="10"/><rect x="100" y="60" width="50" height="50" fill="#808080"/><text x="125" y="85">&lt;AF&gt;02</text></svg>'
    const out = replaceIconsInSvg({
      templateSvg: template,
      iconInfos: [icon('<AF>02', 100, 60, 50, 50)],
      scaleFactorX: 1,
      scaleFactorY: 1,
      matchByLabel: true,
    })
    expect(out).toContain('<image id="icon_AF02" x="100.0" y="60.0"')
    expect(out).not.toContain('<text')
    // 前向更早的 rect 不受影响
    expect(out).toContain('<rect x="0" y="0"')
  })

  it('方式 3：坐标精确匹配（scale 后取整）', () => {
    const template = '<svg><rect x="40" y="60" width="30" height="30" fill="#808080"/></svg>'
    const out = replaceIconsInSvg({
      templateSvg: template,
      iconInfos: [icon('<AF>03', 20, 20, 30, 30)], // scale 2 → (40,60)
      scaleFactorX: 2,
      scaleFactorY: 3, // y: 20*3=60
      matchByLabel: false,
    })
    expect(out).toContain('<image id="icon_AF03" x="40.0" y="60.0" width="60.0" height="90.0"')
    expect(out).not.toContain('<rect')
  })

  it('方式 4：坐标近似匹配（±10 步进 2，须带灰底特征）', () => {
    const template = '<svg><rect x="41" y="59" width="30" height="30" fill="#808080" stroke="black"/></svg>'
    const out = replaceIconsInSvg({
      templateSvg: template,
      iconInfos: [icon('<AF>04', 40, 60, 30, 30)],
      scaleFactorX: 1,
      scaleFactorY: 1,
      matchByLabel: false,
    })
    expect(out).toContain('<image id="icon_AF04"')
  })

  it('方式 5：全未命中 → 追加 </svg> 前', () => {
    const template = '<svg><circle cx="1" r="1"/></svg>'
    const out = replaceIconsInSvg({
      templateSvg: template,
      iconInfos: [icon('<AF>05', 160, 10, 30, 30)],
      scaleFactorX: 1,
      scaleFactorY: 1,
      matchByLabel: true,
    })
    expect(out).toContain(
      '  <image id="icon_AF05" x="160.0" y="10.0" width="30.0" height="30.0" href="data:image/png;base64,aWNvbg==" preserveAspectRatio="xMidYMid meet"/>\n</svg>',
    )
  })

  it('matchByLabel=false → 跳过方式 1/2（直接坐标链）', () => {
    const template =
      '<svg><g id="AF01"><rect x="1" y="1" width="2" height="2"/></g></svg>'
    const out = replaceIconsInSvg({
      templateSvg: template,
      iconInfos: [icon('<AF>01', 1, 1, 2, 2)],
      scaleFactorX: 1,
      scaleFactorY: 1,
      matchByLabel: false,
    })
    // g 未被整组替换（label 链跳过）；坐标精确匹配 rect(1,1) → 替换 rect 保留 g 壳
    expect(out).toContain('<g id="AF01"><image id="icon_AF01" x="1.0" y="1.0"')
  })
})

describe('createEmbeddedFigureSvg（保底 SVG，上游 :3547-3571 逐字）', () => {
  it('内嵌原图 PNG 的最小 SVG（preserveAspectRatio="none"，尾随换行）', () => {
    const svg = createEmbeddedFigureSvg('QUJD', 200, 120)
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120">\n' +
        '  <image x="0" y="0" width="200" height="120" href="data:image/png;base64,QUJD" preserveAspectRatio="none"/>\n' +
        '</svg>\n',
    )
  })
})

describe('samed overlay（灰框 + 黑边 + 白 label）', () => {
  it('字号规则：box 短边 1/4，钳 12..48', () => {
    expect(labelFontSize(100, 40)).toBe(12) // min_dim=40 → 10 → 钳 12
    expect(labelFontSize(100, 100)).toBe(25)
    expect(labelFontSize(400, 400)).toBe(48) // 100 → 钳 48
  })

  it('overlay 结构：rect(#808080/stroke 3) + 居中 text（label 转义）', () => {
    const svg = samedOverlaySvg(200, 120, [
      { id: 0, label: '<AF>01', x1: 10, y1: 5, x2: 70, y2: 45, score: 0.9, prompt: 'icon' },
    ])
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120">')
    expect(svg).toContain('<rect x="10" y="5" width="60" height="40" fill="#808080" stroke="black" stroke-width="3"/>')
    expect(svg).toContain('&lt;AF&gt;01')
    expect(svg).toContain('fill="white"')
    expect(svg.endsWith('</svg>')).toBe(true)
  })
})
