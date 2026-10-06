// AutoFigure prompt 模板（#791 · #744 §3.3 逐字移植纪律）。
// 上游对照：ResearAI/AutoFigure-Edit @ 16f3749 autofigure2.py（MIT derivative work，
// 版权与来源声明见 plugins/autofigure/NOTICE.md）。行号注记 = 上游源码位置。
//
// ⚠️ 结构约定断链即替换失败（#744 §3.3）：步骤 5 的正则/坐标替换依赖这些 prompt 强约束的
// 结构（viewBox/width/height = 原图像素、<g id="AF01"> 占位符、#808080 灰底黑框 spec、
// optimize 八要点检查单）——改写 prompt 前先读 replaceIcons.ts 的匹配面。

// ---------------------------------------------------------------------------
// 步骤 1：生图 prompt（上游 generate_figure_from_method :1345-1374）
// ---------------------------------------------------------------------------

// 参考图模式（上游 :1346-1368，""" 三引号字面量）。V1 面板无参考图输入（#744 Q6 仅
// method_text）——本面保留为上游保真移植资产 + 参考图工作流的 prompt 面（golden 对照覆盖）。
export function buildImageGenPromptWithReference(methodText: string): string {
  return `Generate a figure to visualize the method described below.

You should closely imitate the visual (artistic) style of the reference figure I provide, focusing only on aesthetic aspects, NOT on layout or structure.

Specifically, match:
- overall visual tone and mood
- illustration abstraction level
- line style
- color usage
- shading style
- icon and shape style
- arrow and connector aesthetics
- typography feel

The content structure, number of components, and layout may differ freely.
Only the visual style should be consistent.

The goal is that the figure looks like it was drawn by the same illustrator using the same visual design language as the reference figure.

Below is the method section of the paper:
"""
${methodText}
"""`
}

// 无参考图模式（上游 :1370-1374，默认路径——V1 面板无参考图输入，#744 Q6）。
export function buildImageGenPrompt(methodText: string): string {
  return `Generate a professional academic journal style figure for the paper below so as to visualize the method it proposes, below is the method section of this paper:

${methodText}

The figure should be engaging and using academic journal style with cute characters.`
}

// ---------------------------------------------------------------------------
// 步骤 4：SVG 模板 prompt（上游 generate_svg_template :2371-2439）
// ---------------------------------------------------------------------------

// 无图标模式（上游 :2372-2392）：像素级复现、禁止占位符。
function templateNoIconPrompt(figureWidth: number, figureHeight: number): string {
  return `编写 SVG 代码来尽可能像素级复现这张图片。

当前 SAM3 没有检测到任何有效图标，因此这是一个无图标回退模式任务：
- 不要添加任何灰色矩形占位符
- 不要添加任何 <AF>01 / <AF>02 标签
- 不要凭空生成图标框、占位组或额外装饰
- 所有可见内容都应直接用 SVG 元素复现
- 优先保持整体布局、文字、箭头、线条、边框和配色与原图一致

CRITICAL DIMENSION REQUIREMENT:
- The original image has dimensions: ${figureWidth} x ${figureHeight} pixels
- Your SVG MUST use these EXACT dimensions:
  - Set viewBox="0 0 ${figureWidth} ${figureHeight}"
  - Set width="${figureWidth}" height="${figureHeight}"
- DO NOT scale or resize the SVG

Image reference notes:
- Image 1 is the original target figure.
- Image 2 is the SAM reference image. It does not contain any valid icon placeholder boxes for this run.

Please output ONLY the SVG code, starting with <svg and ending with </svg>. Do not include any explanation or markdown formatting.`
}

// 基础 prompt（上游 :2395-2403，尾部换行保留——box/label/none 追加段与它的拼接形状）。
function templateBasePrompt(figureWidth: number, figureHeight: number): string {
  return `编写svg代码来实现像素级别的复现这张图片（除了图标用相同大小的矩形占位符填充之外其他文字和组件(尤其是箭头样式)都要保持一致（即灰色矩形覆盖的内容就是图标））

CRITICAL DIMENSION REQUIREMENT:
- The original image has dimensions: ${figureWidth} x ${figureHeight} pixels
- Your SVG MUST use these EXACT dimensions to ensure accurate icon placement:
  - Set viewBox="0 0 ${figureWidth} ${figureHeight}"
  - Set width="${figureWidth}" height="${figureHeight}"
- DO NOT scale or resize the SVG
`
}

// box 模式追加段（上游 :2410-2416，首行换行保留）。
function templateBoxSuffix(boxlibJson: string): string {
  return `
ICON COORDINATES FROM boxlib.json:
The following JSON contains precise icon coordinates detected by SAM3:
${boxlibJson}
Use these coordinates to accurately position your icon placeholders in the SVG.

Please output ONLY the SVG code, starting with <svg and ending with </svg>. Do not include any explanation or markdown formatting.`
}

// label 模式追加段（上游 :2420-2435，首行换行保留）。
function templateLabelSuffix(): string {
  return `
PLACEHOLDER STYLE REQUIREMENT:
Look at the second image (samed.png) - each icon area is marked with a gray rectangle (#808080), black border, and a centered label like <AF>01, <AF>02, etc.

Your SVG placeholders MUST match this exact style:
- Rectangle with fill="#808080" and stroke="black" stroke-width="2"
- Centered white text showing the same label (<AF>01, <AF>02, etc.)
- Wrap each placeholder in a <g> element with id matching the label (e.g., id="AF01")

Example placeholder structure:
<g id="AF01">
  <rect x="100" y="50" width="80" height="80" fill="#808080" stroke="black" stroke-width="2"/>
  <text x="140" y="90" text-anchor="middle" dominant-baseline="middle" fill="white" font-size="14">&lt;AF&gt;01</text>
</g>

Please output ONLY the SVG code, starting with <svg and ending with </svg>. Do not include any explanation or markdown formatting.`
}

// none 模式追加段（上游 :2438-2439，首行换行保留）。
function templateNoneSuffix(): string {
  return `
Please output ONLY the SVG code, starting with <svg and ending with </svg>. Do not include any explanation or markdown formatting.`
}

// 步骤 4 prompt 构造（上游 if/elif 链 :2371-2439 的 TS 直译）。boxlibJson =
// boxlib.json 全文（box 模式原文嵌入；label/none 忽略）。
export function buildTemplatePrompt(opts: {
  figureWidth: number
  figureHeight: number
  noIconMode: boolean
  placeholderMode: 'none' | 'box' | 'label'
  boxlibJson: string
}): string {
  const { figureWidth, figureHeight, noIconMode, placeholderMode, boxlibJson } = opts
  if (noIconMode) return templateNoIconPrompt(figureWidth, figureHeight)
  const base = templateBasePrompt(figureWidth, figureHeight)
  if (placeholderMode === 'box') return base + templateBoxSuffix(boxlibJson)
  if (placeholderMode === 'label') return base + templateLabelSuffix()
  return base + templateNoneSuffix()
}

// ---------------------------------------------------------------------------
// 步骤 4.5：SVG 修复 prompt（上游 fix_svg_with_llm :2559-2574）
// ---------------------------------------------------------------------------

// error_list 形状 = "  - <err>" 逐行 join（上游 :2558）。
export function buildFixPrompt(currentSvg: string, errors: readonly string[]): string {
  const errorList = errors.map((err) => `  - ${err}`).join('\n')
  return `The following SVG code has XML syntax errors detected by an XML parser. Please fix ALL the errors and return valid SVG code.

SYNTAX ERRORS DETECTED:
${errorList}

ORIGINAL SVG CODE:
\`\`\`xml
${currentSvg}
\`\`\`

IMPORTANT INSTRUCTIONS:
1. Fix all XML syntax errors (unclosed tags, invalid attributes, unescaped characters, etc.)
2. Ensure the output is valid XML that can be parsed by lxml
3. Keep all the visual elements and structure intact
4. Return ONLY the fixed SVG code, starting with <svg and ending with </svg>
5. Do NOT include any markdown formatting, explanation, or code blocks - just the raw SVG code`
}

// ---------------------------------------------------------------------------
// 步骤 4.6：SVG 优化 prompt（上游 optimize_svg_with_llm :3054-3113）
// ---------------------------------------------------------------------------

// 无图标模式（上游 :3054-3079）。
export function buildOptimizePromptNoIcon(currentSvg: string): string {
  return `You are an expert SVG optimizer. Compare the current SVG rendering with the original figure and optimize the SVG code to better match the original.

I'm providing you with 4 inputs:
1. **Image 1 (figure.png)**: The original target figure that we want to replicate
2. **Image 2 (samed.png)**: The SAM reference image for this run. No valid icon boxes were detected.
3. **Image 3 (current SVG rendered as PNG)**: The current state of our SVG
4. **Current SVG code**: The SVG code that needs optimization

Please carefully compare and optimize:
1. Overall layout and spatial alignment
2. Text positions, font sizes, and colors
3. Arrows, connectors, borders, and strokes
4. Shapes, grouping, and visual hierarchy

**CURRENT SVG CODE:**
\`\`\`xml
${currentSvg}
\`\`\`

**IMPORTANT:**
- Output ONLY the optimized SVG code
- Start with <svg and end with </svg>
- Do NOT include markdown formatting or explanations
- No valid icon placeholders exist for this figure
- Do NOT add gray rectangles, AF labels, placeholder groups, or synthetic icon boxes
- Focus on position and style corrections`
}

// 常规模式（上游 :3081-3113，八要点检查单）。
export function buildOptimizePrompt(currentSvg: string): string {
  return `You are an expert SVG optimizer. Compare the current SVG rendering with the original figure and optimize the SVG code to better match the original.

I'm providing you with 4 inputs:
1. **Image 1 (figure.png)**: The original target figure that we want to replicate
2. **Image 2 (samed.png)**: The same figure with icon positions marked as gray rectangles with labels (<AF>01, <AF>02, etc.)
3. **Image 3 (current SVG rendered as PNG)**: The current state of our SVG
4. **Current SVG code**: The SVG code that needs optimization

Please carefully compare and check the following **TWO MAJOR ASPECTS with EIGHT KEY POINTS**:

## ASPECT 1: POSITION (位置)
1. **Icons (图标)**: Are icon placeholder positions matching the original?
2. **Text (文字)**: Are text elements positioned correctly?
3. **Arrows (箭头)**: Are arrows starting/ending at correct positions?
4. **Lines/Borders (线条)**: Are lines and borders aligned properly?

## ASPECT 2: STYLE (样式)
5. **Icons (图标)**: Icon placeholder sizes, proportions (must have gray fill #808080, black border, and centered label)
6. **Text (文字)**: Font sizes, colors, weights
7. **Arrows (箭头)**: Arrow styles, thicknesses, colors
8. **Lines/Borders (线条)**: Line styles, colors, stroke widths

**CURRENT SVG CODE:**
\`\`\`xml
${currentSvg}
\`\`\`

**IMPORTANT:**
- Output ONLY the optimized SVG code
- Start with <svg and end with </svg>
- Do NOT include markdown formatting or explanations
- Keep all icon placeholder structures intact (the <g> elements with id like "AF01")
- Focus on position and style corrections`
}
