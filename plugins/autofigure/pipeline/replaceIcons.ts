// 步骤 5：图标替换到 SVG（#791 · 上游 replace_icons_in_svg :2707-2915 逐字直译）。
// 上游对照：ResearAI/AutoFigure-Edit @ 16f3749（MIT derivative work，见 NOTICE.md）。
//
// 替换策略链（逐 icon 依序尝试，命中即止）：
//   1. label 模式 <g id="AF01"> 整组替换（含 transform translate 坐标合并 + rect 尺寸提取）
//   2. label 模式 <text> 邻近（前向最近）<rect> 替换 + text 删除
//   3. 坐标精确匹配（scale 后取整）
//   4. 坐标近似匹配（±10 步进 2，须带灰底/黑框特征）
//   5. 追加到 </svg> 前
//
// ⚠️ 本文件的匹配面依赖 prompts.ts 强约束的结构约定（<g id="AF01">、#808080 灰底黑框、
// viewBox = 原图像素）——改 prompt 前先读本文件（#744 §3.3 断链警告）。

import { pyRound } from './sam3Parse'
import type { IconInfo } from './values'

// Python float repr：整数带 .0 后缀（f"{x}" of float 语义——JS String(10.0)='10' 不保真）。
function pyFloatStr(n: number): string {
  if (Number.isInteger(n)) return `${n}.0`
  return String(n)
}

// Python format(n, '.1f')。二进制浮点的 half 边界舍入差异（Python half-even vs JS toFixed
// half-up）在整数坐标场景不可见——坐标值经 scale 后非精确 .x5 边界（golden 对照覆盖）。
function pyFormatF1(n: number): string {
  return n.toFixed(1)
}

function imageTagExact(labelClean: string, x: number, y: number, width: number, height: number, iconB64: string): string {
  return `<image id="icon_${labelClean}" x="${pyFloatStr(x)}" y="${pyFloatStr(y)}" width="${pyFloatStr(width)}" height="${pyFloatStr(height)}" href="data:image/png;base64,${iconB64}" preserveAspectRatio="xMidYMid meet"/>`
}

function imageTagScaled(labelClean: string, x1: number, y1: number, width: number, height: number, iconB64: string): string {
  return `<image id="icon_${labelClean}" x="${pyFormatF1(x1)}" y="${pyFormatF1(y1)}" width="${pyFormatF1(width)}" height="${pyFormatF1(height)}" href="data:image/png;base64,${iconB64}" preserveAspectRatio="xMidYMid meet"/>`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceFirstOfAll(haystack: string, needle: string, replacement: string): string {
  // Python str.replace 全量替换语义（方式 1 / 追加段）
  return haystack.split(needle).join(replacement)
}

export interface ReplaceIconInput {
  readonly label: string
  readonly labelClean: string
  readonly x1: number
  readonly y1: number
  readonly width: number
  readonly height: number
  readonly nobgPngB64: string
}

export function replaceIconsInSvg(opts: {
  templateSvg: string
  iconInfos: readonly (Pick<IconInfo, 'label' | 'labelClean' | 'x1' | 'y1' | 'width' | 'height'> & { readonly nobgPngB64: string })[]
  scaleFactorX: number
  scaleFactorY: number
  matchByLabel: boolean
}): string {
  let svgContent = opts.templateSvg

  for (const iconInfo of opts.iconInfos) {
    const { label, labelClean } = iconInfo
    let replaced = false

    if (opts.matchByLabel && label) {
      // 方式 1：<g id="AF01"> 整组替换（上游 :2751-2810）
      const gPattern = new RegExp(
        `<g[^>]*\\bid=["']?${escapeRegExp(labelClean)}["']?[^>]*>[\\s\\S]*?</g>`,
        'i',
      )
      const gMatch = gPattern.exec(svgContent)
      if (gMatch) {
        const gContent = gMatch[0]

        // 提取 <g> 开 tag 的 transform="translate(x, y)"（LLM 生成 translate 形态的坐标合并）
        let translateX = 0.0
        let translateY = 0.0
        const gTagMatch = /^<g[^>]*>/i.exec(gContent)
        if (gTagMatch) {
          const transformPattern = /transform=["'][^"']*translate\s*\(\s*([\d.-]+)[\s,]+([\d.-]+)\s*\)/i
          const transformMatch = transformPattern.exec(gTagMatch[0])
          if (transformMatch) {
            translateX = Number(transformMatch[1])
            translateY = Number(transformMatch[2])
          }
        }

        // <g> 内 rect 尺寸提取（属性序 x/y/w/h 与 w/h/x/y 双模式，上游 :2771-2794）
        const rectPatternXyFirst =
          /<rect[^>]*\bx=["']?([\d.]+)["']?[^>]*\by=["']?([\d.]+)["']?[^>]*\bwidth=["']?([\d.]+)["']?[^>]*\bheight=["']?([\d.]+)["']?/i
        const rectPatternWhFirst =
          /<rect[^>]*\bwidth=["']?([\d.]+)["']?[^>]*\bheight=["']?([\d.]+)["']?[^>]*\bx=["']?([\d.]+)["']?[^>]*\by=["']?([\d.]+)["']?/i

        let rectInfo: { x: number; y: number; width: number; height: number } | null = null
        // 上游 for 循环依次试双模式：pattern1 匹配即用（x/y/w/h 序），否则 pattern2（w/h/x/y 序）
        const m1 = rectPatternXyFirst.exec(gContent)
        if (m1) {
          rectInfo = { x: Number(m1[1]), y: Number(m1[2]), width: Number(m1[3]), height: Number(m1[4]) }
        } else {
          const m2 = rectPatternWhFirst.exec(gContent)
          if (m2) {
            rectInfo = { x: Number(m2[3]), y: Number(m2[4]), width: Number(m2[1]), height: Number(m2[2]) }
          }
        }

        if (rectInfo) {
          const x = rectInfo.x + translateX
          const y = rectInfo.y + translateY
          const width = rectInfo.width
          const height = rectInfo.height
          const imageTag = imageTagExact(labelClean, x, y, width, height, iconInfo.nobgPngB64)
          // Python str.replace 全量替换语义（g_content 理论唯一）
          svgContent = replaceFirstOfAll(svgContent, gContent, imageTag)
          replaced = true
        }
      }

      // 方式 2：<text> 邻近（前向最近）<rect> 替换（上游 :2813-2855）
      if (!replaced) {
        const textPatterns = [
          new RegExp(`<text[^>]*>[^<]*${escapeRegExp(label)}[^<]*</text>`, 'i'),
          new RegExp(`<text[^>]*>[^<]*&lt;AF&gt;${escapeRegExp(labelClean.slice(2))}[^<]*</text>`, 'i'),
        ]
        for (const tp of textPatterns) {
          const textMatch = tp.exec(svgContent)
          if (!textMatch) continue
          const textPos = textMatch.index
          const precedingSvg = svgContent.slice(0, textPos)

          // 前向最后一个 <rect ...>
          const rectMatches = [...precedingSvg.matchAll(/<rect[^>]*\/?\s*>/gi)]
          if (rectMatches.length === 0) continue
          const rectContent = rectMatches[rectMatches.length - 1][0]

          const xMatch = /\bx=["']?([\d.]+)/.exec(rectContent)
          const yMatch = /\by=["']?([\d.]+)/.exec(rectContent)
          const wMatch = /\bwidth=["']?([\d.]+)/.exec(rectContent)
          const hMatch = /\bheight=["']?([\d.]+)/.exec(rectContent)

          if (xMatch && yMatch && wMatch && hMatch) {
            const x = Number(xMatch[1])
            const y = Number(yMatch[1])
            const width = Number(wMatch[1])
            const height = Number(hMatch[1])
            const imageTag = imageTagExact(labelClean, x, y, width, height, iconInfo.nobgPngB64)
            // 删除 text（Python str.replace 全量）+ 替换首个 rect
            svgContent = replaceFirstOfAll(svgContent, textMatch[0], '')
            svgContent = svgContent.replace(rectContent, imageTag)
            replaced = true
            break
          }
        }
      }
    }

    // 回退：坐标匹配（scale 后精确 → 近似 ±10 步进 2；上游 :2857-2893）
    if (!replaced) {
      const x1 = iconInfo.x1 * opts.scaleFactorX
      const y1 = iconInfo.y1 * opts.scaleFactorY
      const width = iconInfo.width * opts.scaleFactorX
      const height = iconInfo.height * opts.scaleFactorY
      const imageTag = imageTagScaled(labelClean, x1, y1, width, height, iconInfo.nobgPngB64)

      // Python int(round(x))（banker's rounding）——Math.trunc 不保真
      const x1Int = pyRound(x1)
      const y1Int = pyRound(y1)

      // 精确匹配
      const rectPattern = new RegExp(
        `<rect[^>]*x=["']?${x1Int}(?:\\.0)?["']?[^>]*y=["']?${y1Int}(?:\\.0)?["']?[^>]*/?\\s*>`,
        'i',
      )
      if (rectPattern.test(svgContent)) {
        svgContent = svgContent.replace(rectPattern, imageTag)
        replaced = true
      } else {
        // 近似匹配（须带灰底/黑框特征）
        const tolerance = 10
        outer: for (let dx = -tolerance; dx <= tolerance; dx += 2) {
          for (let dy = -tolerance; dy <= tolerance; dy += 2) {
            const searchX = x1Int + dx
            const searchY = y1Int + dy
            const approximatePattern = new RegExp(
              `<rect[^>]*x=["']?${searchX}(?:\\.0)?["']?[^>]*y=["']?${searchY}(?:\\.0)?["']?[^>]*(?:fill=["']?(?:#[0-9A-Fa-f]{3,6}|gray|grey)["']?|stroke=["']?(?:black|#000|#000000)["']?)[^>]*/?\\s*>`,
              'i',
            )
            if (approximatePattern.test(svgContent)) {
              svgContent = svgContent.replace(approximatePattern, imageTag)
              replaced = true
              break outer
            }
          }
        }
      }
    }

    // 追加到 SVG 末尾（上游 :2895-2906）
    if (!replaced) {
      const x1 = iconInfo.x1 * opts.scaleFactorX
      const y1 = iconInfo.y1 * opts.scaleFactorY
      const width = iconInfo.width * opts.scaleFactorX
      const height = iconInfo.height * opts.scaleFactorY
      const imageTag = imageTagScaled(labelClean, x1, y1, width, height, iconInfo.nobgPngB64)
      svgContent = replaceFirstOfAll(svgContent, '</svg>', `  ${imageTag}\n</svg>`)
    }
  }

  return svgContent
}
