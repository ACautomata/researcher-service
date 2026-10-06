// AutoFigure 流水线固定 graph（#791 票 1 · #744 §1/§3.1：控制面专用 LangGraph pipeline，
// 非 agent loop——随会话 run 执行的六节点固定拓扑）。
// 上游对照：ResearAI/AutoFigure-Edit @ 16f3749 method_to_svg（MIT derivative work，见 NOTICE.md）。
//
// 拓扑（§3.1 六节点）：START → 生图 → 分割 → 图标准备 → 模板生成 → 组装 → 预览渲染 → END
// 失败语义（§3.1 表逐点保真）：
//   生图失败 → run failed（上游 raise）            分割云 API 失败 → run failed
//   分割无命中 → no_icon_mode（回退链 §3.2）        图标准备失败 → 降级 no_icon_mode
//   模板生成：fix ≤3 / optimize 迭代异常 continue / no_icon 失败 → embedded 保底（不向上抛）
//   组装失败 → run failed（纯逻辑，理论不可达）      渲染失败 → 不致命（预览缺省 + meta 标记）
//
// 全部计算面经 FigureComputePorts 注入（S2 可 fake）；graph 零直连 LLM/云 API/文件系统。

import { END, START, StateGraph, Annotation } from '../../../server/src/plugins/autofigureDeps'
import type { LangGraphRunnableConfig } from '../../../server/src/plugins/autofigureDeps'
import {
  buildImageGenPrompt,
  buildFixPrompt,
  buildOptimizePrompt,
  buildOptimizePromptNoIcon,
  buildTemplatePrompt,
} from '../prompts'
import type { FigureComputePorts } from '../compute/ports'
import {
  buildBoxlib,
  buildValidBoxes,
} from './sam3Parse'
import { extractSvgCode, validateSvgSyntax } from './svgExtract'
import { getSvgDimensions, calculateScaleFactors } from './svgDims'
import { replaceIconsInSvg } from './replaceIcons'
import { createEmbeddedFigureSvg } from './samed'
import { pngToDataUri as encodePngToDataUri } from './dataUri'
import type {
  Boxlib,
  EvaluationMeta,
  FigureStage,
  IconInfo,
  PipelineConfig,
  SamBox,
} from './values'
import { DEFAULT_PIPELINE_CONFIG } from './values'

// LLM 调用参数（上游保真：步骤 4 :2451 temp 默认 0.7；fix :2583-2584 16000/0.3；
// optimize :3125-3126 50000/0.3）。
const TEMPLATE_LLM_OPTS = { maxTokens: 50000, temperature: 0.7 } as const
const FIX_LLM_OPTS = { maxTokens: 16000, temperature: 0.3 } as const
const OPTIMIZE_LLM_OPTS = { maxTokens: 50000, temperature: 0.3 } as const
const FIX_MAX_RETRIES = 3

// 4K 等比放大目标长边（上游 UPSCALE_TARGET_LONG_EDGE；面板 V1 默认开，#744 Q6 参数内置）。
const UPSCALE_TARGET_LONG_EDGE = 3840

export interface PipelineState {
  methodText: string
  config: PipelineConfig
  models: { readonly imageGen: string; readonly svg: string }

  figurePng?: Uint8Array
  figureWidth?: number
  figureHeight?: number
  samedPng?: Uint8Array
  boxlib?: Boxlib
  validBoxes: SamBox[]
  icons: IconInfo[]
  noIconMode: boolean

  templateSvg?: string
  optimizedSvg?: string
  finalSvg?: string
  previewPng?: Uint8Array
  meta: EvaluationMeta
}

const PipelineAnnotation = {
  methodText: Annotation<string>,
  config: Annotation<PipelineConfig>,
  models: Annotation<{ readonly imageGen: string; readonly svg: string }>,
  figurePng: Annotation<Uint8Array | undefined>,
  figureWidth: Annotation<number | undefined>,
  figureHeight: Annotation<number | undefined>,
  samedPng: Annotation<Uint8Array | undefined>,
  boxlib: Annotation<Boxlib | undefined>,
  validBoxes: Annotation<SamBox[]>({ reducer: (a, b) => b ?? a, default: () => [] }),
  icons: Annotation<IconInfo[]>({ reducer: (a, b) => b ?? a, default: () => [] }),
  noIconMode: Annotation<boolean>({ reducer: (a, b) => b ?? a, default: () => false }),
  templateSvg: Annotation<string | undefined>,
  optimizedSvg: Annotation<string | undefined>,
  finalSvg: Annotation<string | undefined>,
  previewPng: Annotation<Uint8Array | undefined>,
  meta: Annotation<EvaluationMeta>,
}

// ---------------------------------------------------------------------------
// graph 工厂（纯函数——同参数必同拓扑；固定 graph 无缓存因子面，票 4 装配决定实例生命周期）
// ---------------------------------------------------------------------------

export interface FigurePipelineInvokeOptions {
  readonly signal?: AbortSignal
  /** 阶段进度上报（#744 §5.5 六 stage；SSE 接线归票 4，本票为直调面） */
  readonly onStage?: (stage: FigureStage) => void
}

export interface FigurePipelineResult {
  readonly finalSvg: string
  readonly previewPng: Uint8Array | undefined
  readonly noIconMode: boolean
  readonly meta: EvaluationMeta
}

export interface FigurePipelineGraph {
  invoke(
    init: {
      methodText: string
      config?: Partial<PipelineConfig>
      models: { readonly imageGen: string; readonly svg: string }
    },
    options?: FigurePipelineInvokeOptions,
  ): Promise<FigurePipelineResult>
}

export function createFigurePipelineGraph(
  ports: FigureComputePorts,
  initialMeta?: Partial<EvaluationMeta>,
): FigurePipelineGraph {
  const baseMeta: EvaluationMeta = {
    v: 1,
    noIconMode: false,
    placeholderMode: DEFAULT_PIPELINE_CONFIG.placeholderMode,
    fixAttempts: 0,
    optimizeIterations: DEFAULT_PIPELINE_CONFIG.optimizeIterations,
    optimizeCompleted: 0,
    imageGenModel: '',
    svgModel: '',
    renderer: '',
    previewReady: false,
    cloudCalls: { sam3: 0, rmbg: 0 },
    ...initialMeta,
  }

  const workflow = new StateGraph({ stateSchema: Annotation.Root(PipelineAnnotation) })
    .addNode('generateImage', (state, config) => generateImageNode(state, ports, config))
    .addNode('segment', (state, config) => segmentNode(state, ports, config))
    .addNode('prepareIcons', (state, config) => prepareIconsNode(state, ports, config))
    .addNode('template', (state, config) => templateNode(state, ports, config))
    .addNode('assemble', (state, config) => assembleNode(state, config))
    .addNode('renderPreview', (state, config) => renderPreviewNode(state, ports, config))
    .addEdge(START, 'generateImage')
    .addEdge('generateImage', 'segment')
    .addEdge('segment', 'prepareIcons')
    .addEdge('prepareIcons', 'template')
    .addEdge('template', 'assemble')
    .addEdge('assemble', 'renderPreview')
    .addEdge('renderPreview', END)

  const compiled = workflow.compile()

  return {
    async invoke(init, options) {
      const state = await compiled.invoke(
        {
          methodText: init.methodText,
          config: { ...DEFAULT_PIPELINE_CONFIG, ...init.config },
          models: init.models,
          meta: { ...baseMeta, imageGenModel: init.models.imageGen, svgModel: init.models.svg },
        },
        {
          ...(options?.signal ? { signal: options.signal } : {}),
          configurable: { onStage: options?.onStage },
        },
      )
      if (state.finalSvg === undefined) {
        // 拓扑终局必有 finalSvg（template/assemble 两节点兜底链）——理论不可达的防御面。
        throw new Error('pipeline finished without final SVG')
      }
      return {
        finalSvg: state.finalSvg,
        previewPng: state.previewPng,
        noIconMode: state.noIconMode,
        meta: state.meta,
      }
    },
  }
}

function stage(config: LangGraphRunnableConfig | undefined, name: FigureStage): void {
  const onStage = config?.configurable?.onStage as ((stage: FigureStage) => void) | undefined
  onStage?.(name)
}



// ---------------------------------------------------------------------------
// 节点 1：生图（上游 generate_figure_from_method 直译——失败即 run failed）
// ---------------------------------------------------------------------------

async function generateImageNode(
  state: PipelineState,
  ports: FigureComputePorts,
  config: LangGraphRunnableConfig | undefined,
): Promise<Partial<PipelineState>> {
  stage(config, 'generating')
  const prompt = buildImageGenPrompt(state.methodText)
  const img = await ports.imageGen.generate(prompt, state.models.imageGen)
  // 4K 等比放大（上游 enable_upscale 默认开；面板 V1 恒开，#744 Q6 参数内置）
  const { png } = await ports.imageOps.upscaleTo4k(img.png, UPSCALE_TARGET_LONG_EDGE)
  const size = await ports.imageOps.sizeOf(png)
  return {
    figurePng: png,
    figureWidth: size.width,
    figureHeight: size.height,
    meta: { ...state.meta, imageGenModel: state.models.imageGen },
  }
}

// ---------------------------------------------------------------------------
// 节点 2：分割（上游 segment_with_sam3 直译——逐 prompt 检测合并；无命中 → no_icon_mode）
// ---------------------------------------------------------------------------

async function segmentNode(
  state: PipelineState,
  ports: FigureComputePorts,
  config: LangGraphRunnableConfig | undefined,
): Promise<Partial<PipelineState>> {
  stage(config, 'segmenting')
  const figurePng = state.figurePng
  const figureWidth = state.figureWidth
  const figureHeight = state.figureHeight
  if (!figurePng || !figureWidth || !figureHeight) throw new Error('segment: missing figure image')

  const dataUri = encodePngToDataUri(figurePng)
  let sam3Calls = 0
  const perPrompt: { prompt: string; detections: Awaited<ReturnType<typeof ports.sam3.segment>> }[] = []
  for (const prompt of state.config.samPrompts) {
    sam3Calls += 1
    const detections = await ports.sam3.segment(dataUri, prompt, state.config.samMaxMasks, figureWidth, figureHeight)
    perPrompt.push({ prompt, detections })
  }

  const validBoxes = buildValidBoxes(perPrompt, state.config.minScore, state.config.mergeThreshold)
  const boxlib = buildBoxlib(figureWidth, figureHeight, state.config.samPrompts, validBoxes)
  const noIconMode = validBoxes.length === 0

  // samed 标记图（上游灰框 + 黑边 + 白 label；无命中 = 纯原图副本）
  const samedPng = await ports.imageOps.drawBoxes(figurePng, validBoxes)

  return {
    samedPng,
    boxlib,
    validBoxes,
    noIconMode,
    meta: {
      ...state.meta,
      noIconMode,
      cloudCalls: { ...state.meta.cloudCalls, sam3: state.meta.cloudCalls.sam3 + sam3Calls },
    },
  }
}

// ---------------------------------------------------------------------------
// 节点 3：图标准备（#744 §3.1：失败 → no_icon_mode 降级；no_icon_mode 下跳过）
// ---------------------------------------------------------------------------

async function prepareIconsNode(
  state: PipelineState,
  ports: FigureComputePorts,
  config: LangGraphRunnableConfig | undefined,
): Promise<Partial<PipelineState>> {
  if (state.noIconMode) return { icons: [] }
  stage(config, 'preparing')

  const figurePng = state.figurePng
  if (!figurePng) throw new Error('prepareIcons: missing figure image')

  let rmbgCalls = 0
  try {
    const icons: IconInfo[] = []
    for (const box of state.validBoxes) {
      const cropPng = await ports.imageOps.crop(figurePng, { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 })
      rmbgCalls += 1
      const nobgPng = await ports.rmbg.removeBackground(cropPng)
      icons.push({
        id: box.id,
        label: box.label,
        labelClean: box.label.replace(/</g, '').replace(/>/g, ''),
        x1: box.x1,
        y1: box.y1,
        x2: box.x2,
        y2: box.y2,
        width: box.x2 - box.x1,
        height: box.y2 - box.y1,
        cropPng,
        nobgPng,
      })
    }
    return {
      icons,
      meta: { ...state.meta, cloudCalls: { ...state.meta.cloudCalls, rmbg: state.meta.cloudCalls.rmbg + rmbgCalls } },
    }
  } catch (e) {
    // #744 §3.1：图标准备失败 → no_icon_mode（模板走「像素级复现」prompt，保底链继续）
    return {
      icons: [],
      noIconMode: true,
      meta: {
        ...state.meta,
        noIconMode: true,
        cloudCalls: { ...state.meta.cloudCalls, rmbg: state.meta.cloudCalls.rmbg + rmbgCalls },
      },
    }
  }
}

// ---------------------------------------------------------------------------
// 节点 4：模板生成（上游 generate_svg_template + check_and_fix_svg + optimize_svg_with_llm；
// try 块包住全部——no_icon 失败 → embedded 保底，非 no_icon 上抛）
// ---------------------------------------------------------------------------

// fix ≤3 循环（上游 fix_svg_with_llm 直译：修复失败把新错误喂下一轮；耗尽返回最后一次）。
async function checkAndFixSvg(
  svgCode: string,
  ports: FigureComputePorts,
  model: string,
): Promise<{ svg: string; fixAttempts: number }> {
  const first = validateSvgSyntax(svgCode)
  if (first.valid) return { svg: svgCode, fixAttempts: 0 }

  let currentSvg = svgCode
  let currentErrors = first.errors
  let fixAttempts = 0
  for (let attempt = 0; attempt < FIX_MAX_RETRIES; attempt++) {
    fixAttempts += 1
    const prompt = buildFixPrompt(currentSvg, currentErrors)
    let content: string
    try {
      content = await ports.llm.text(prompt, model, FIX_LLM_OPTS)
    } catch {
      continue
    }
    if (!content) continue
    const fixedSvg = extractSvgCode(content)
    if (!fixedSvg) continue
    const check = validateSvgSyntax(fixedSvg)
    if (check.valid) return { svg: fixedSvg, fixAttempts }
    currentSvg = fixedSvg
    currentErrors = check.errors
  }
  return { svg: currentSvg, fixAttempts }
}

async function templateNode(
  state: PipelineState,
  ports: FigureComputePorts,
  config: LangGraphRunnableConfig | undefined,
): Promise<Partial<PipelineState>> {
  stage(config, 'templating')
  const figurePng = state.figurePng
  const samedPng = state.samedPng
  const figureWidth = state.figureWidth
  const figureHeight = state.figureHeight
  if (!figurePng || !samedPng || !figureWidth || !figureHeight) {
    throw new Error('template: missing pipeline inputs')
  }

  try {
    // 步骤 4：模板生成（fix 循环内嵌）
    const prompt = buildTemplatePrompt({
      figureWidth,
      figureHeight,
      noIconMode: state.noIconMode,
      placeholderMode: state.config.placeholderMode,
      boxlibJson: JSON.stringify(state.boxlib, null, 2),
    })
    const content = await ports.llm.multimodal(
      [prompt, { png: figurePng }, { png: samedPng }],
      state.models.svg,
      TEMPLATE_LLM_OPTS,
    )
    if (!content) throw new Error('template: empty LLM response')
    const svgCode = extractSvgCode(content)
    if (!svgCode) throw new Error('template: no SVG in response')

    const fixed = await checkAndFixSvg(svgCode, ports, state.models.svg)
    const templateSvg = fixed.svg

    // 步骤 4.6：optimize 迭代（上游主编排 skip_base64_validation=True；单次异常 continue；
    // 渲染失败 break——保留上一版）
    let optimizedSvg: string | undefined
    let optimizeCompleted = 0
    let optimizeFixAttempts = 0
    if (state.config.optimizeIterations === 0) {
      optimizedSvg = undefined // 上游直接复制模板（is_file 判定 → assemble 用 template）
    } else {
      let currentSvg = templateSvg
      for (let iteration = 0; iteration < state.config.optimizeIterations; iteration++) {
        try {
          const rendered = await ports.render.svgToPng(currentSvg, figureWidth, figureHeight)
          if (rendered === null) break
          const optPrompt = state.noIconMode
            ? buildOptimizePromptNoIcon(currentSvg)
            : buildOptimizePrompt(currentSvg)
          const optContent = await ports.llm.multimodal(
            [optPrompt, { png: figurePng }, { png: samedPng }, { png: rendered }],
            state.models.svg,
            OPTIMIZE_LLM_OPTS,
          )
          if (!optContent) continue
          let optimized = extractSvgCode(optContent)
          if (!optimized) continue
          const check = validateSvgSyntax(optimized)
          if (!check.valid) {
            const refixed = await checkAndFixSvg(optimized, ports, state.models.svg)
            optimized = refixed.svg
            optimizeFixAttempts += refixed.fixAttempts
          }
          // skip_base64_validation=True（上游 method_to_svg :3447）——不校验嵌入图
          currentSvg = optimized
          optimizeCompleted += 1
        } catch {
          continue
        }
      }
      optimizedSvg = currentSvg !== templateSvg ? currentSvg : undefined
    }

    return {
      templateSvg,
      optimizedSvg,
      meta: {
        ...state.meta,
        // fixAttempts = 步骤 4.5 首验修复 + optimize 迭代内 refix 全量（§5.1 迭代数记录完整）
        fixAttempts: state.meta.fixAttempts + fixed.fixAttempts + optimizeFixAttempts,
        optimizeIterations: state.config.optimizeIterations,
        optimizeCompleted,
      },
    }
  } catch (e) {
    if (!state.noIconMode) throw e
    // #744 §3.2 保底链：no_icon_mode 且模板重建失败 → 内嵌原图 SVG（不向上抛）
    const figureB64 = Buffer.from(figurePng).toString('base64')
    return { finalSvg: createEmbeddedFigureSvg(figureB64, figureWidth, figureHeight) }
  }
}

// ---------------------------------------------------------------------------
// 节点 5：组装（上游步骤 5 直译——no_icon 直接输出模板；正常走坐标对齐 + 替换策略链）
// ---------------------------------------------------------------------------

async function assembleNode(
  state: PipelineState,
  config: LangGraphRunnableConfig | undefined,
): Promise<Partial<PipelineState>> {
  stage(config, 'assembling')
  const figureWidth = state.figureWidth
  const figureHeight = state.figureHeight
  if (!figureWidth || !figureHeight) throw new Error('assemble: missing figure dimensions')

  const svgTemplateForReplace = state.optimizedSvg ?? state.templateSvg

  if (state.noIconMode) {
    if (svgTemplateForReplace !== undefined) {
      return { finalSvg: svgTemplateForReplace }
    }
    // 上游 :3481-3485「无图标模式缺少模板 SVG，生成保底 final.svg」
    const figurePng = state.figurePng
    if (!figurePng) throw new Error('assemble: missing figure image')
    const figureB64 = Buffer.from(figurePng).toString('base64')
    return { finalSvg: createEmbeddedFigureSvg(figureB64, figureWidth, figureHeight) }
  }

  if (svgTemplateForReplace === undefined) {
    throw new Error('assemble: no template SVG available')
  }

  // 步骤 4.7 坐标对齐（上游 :3487-3515：SVG 尺寸 vs 原图像素 → 缩放因子；尺寸匹配 = 1:1）
  const [svgWidth, svgHeight] = getSvgDimensions(svgTemplateForReplace)
  let scaleX = 1.0
  let scaleY = 1.0
  if (svgWidth !== null && svgHeight !== null) {
    if (Math.abs(svgWidth - figureWidth) >= 1 || Math.abs(svgHeight - figureHeight) >= 1) {
      ;[scaleX, scaleY] = calculateScaleFactors(figureWidth, figureHeight, svgWidth, svgHeight)
    }
  }

  const finalSvg = replaceIconsInSvg({
    templateSvg: svgTemplateForReplace,
    iconInfos: state.icons.map((icon) => ({
      label: icon.label,
      labelClean: icon.labelClean,
      x1: icon.x1,
      y1: icon.y1,
      width: icon.width,
      height: icon.height,
      nobgPngB64: Buffer.from(icon.nobgPng).toString('base64'),
    })),
    scaleFactorX: scaleX,
    scaleFactorY: scaleY,
    matchByLabel: state.config.placeholderMode === 'label',
  })
  return { finalSvg }
}

// ---------------------------------------------------------------------------
// 节点 6：预览渲染（失败不致命——SVG 仍是产物；预览缺失标记进元数据）
// ---------------------------------------------------------------------------

async function renderPreviewNode(
  state: PipelineState,
  ports: FigureComputePorts,
  config: LangGraphRunnableConfig | undefined,
): Promise<Partial<PipelineState>> {
  stage(config, 'rendering')
  const finalSvg = state.finalSvg
  const figureWidth = state.figureWidth
  const figureHeight = state.figureHeight
  if (finalSvg === undefined) throw new Error('renderPreview: missing final SVG')

  const png =
    figureWidth && figureHeight ? await ports.render.svgToPng(finalSvg, figureWidth, figureHeight) : null
  if (png === null) {
    return { meta: { ...state.meta, previewReady: false } }
  }
  return { previewPng: png, meta: { ...state.meta, previewReady: true } }
}
