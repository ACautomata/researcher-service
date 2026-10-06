// AutoFigure 流水线共享类型（#791 · #744 v2 §3.1 graph 状态 / §5.1 EvaluationMeta）。
// 上游对照：ResearAI/AutoFigure-Edit @ 16f3749 autofigure2.py（MIT，derivative work 保留
// 版权与来源声明——见 plugins/autofigure/NOTICE.md）。逐字移植纪律见 #744 §3.3。

// ---------------------------------------------------------------------------
// SAM3 box 域（步骤 2 产物；上游 valid_boxes / boxlib.json 形状）
// ---------------------------------------------------------------------------

// 上游 segment_with_sam3 的 valid_boxes 元素（label 分配规则 `<AF>{i+1:02d}`，merge 后重新编号）。
export interface SamBox {
  readonly id: number
  readonly label: string // `<AF>01` 形态（带尖括号）
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly score: number
  readonly prompt: string
}

// boxlib.json 数据面（上游 boxlib_data 字典：image_size/prompts_used/boxes/no_icon_mode）。
export interface Boxlib {
  readonly image_size: { readonly width: number; readonly height: number }
  readonly prompts_used: readonly string[]
  readonly boxes: readonly SamBox[]
  readonly no_icon_mode: boolean
}

// 步骤 3 产物：图标信息（上游 icon_infos 元素；裁切/去背景图字节在 TS 侧内存传递，不落盘）。
export interface IconInfo {
  readonly id: number
  readonly label: string
  readonly labelClean: string
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly width: number
  readonly height: number
  readonly cropPng: Uint8Array
  readonly nobgPng: Uint8Array
}

// ---------------------------------------------------------------------------
// SAM3 单次检测（像素坐标；min_score 过滤在 buildValidBoxes——上游逐 prompt 检测合并的
// 元素形状）
export interface Sam3Detection {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly score: number | null
}

// ---------------------------------------------------------------------------
// 占位符模式（上游 PlaceholderMode；V1 面板常量 label，#744 Q6「参数内置常量」）
// ---------------------------------------------------------------------------

export type PlaceholderMode = 'none' | 'box' | 'label'

// ---------------------------------------------------------------------------
// pipeline 元数据（#744 §5.1：evaluation 列改存 pipeline 元数据）
// ---------------------------------------------------------------------------

export interface EvaluationMeta {
  /** 元数据版本（形状演进判别）。 */
  readonly v: 1
  /** SAM3 无命中回退链标记（#744 §3.2）。 */
  readonly noIconMode: boolean
  /** 占位符模式（V1 = label）。 */
  readonly placeholderMode: PlaceholderMode
  /** 步骤 4.5 fix 循环实际执行的 LLM 修复次数（≤3）。 */
  readonly fixAttempts: number
  /** 步骤 4.6 配置的最大优化迭代数。 */
  readonly optimizeIterations: number
  /** 步骤 4.6 实际完成的迭代数（单次异常 continue / base64 校验不过拒绝保留上一版）。 */
  readonly optimizeCompleted: number
  /** 生图模型名（面板级配置，纯字符串）。 */
  readonly imageGenModel: string
  /** SVG 模板/优化模型名（owner provider 配置）。 */
  readonly svgModel: string
  /** SVG→PNG 渲染器标记（渲染器差异影响 optimize 输入，#744 §3.3）。graph 不覆盖本字段——
   *  由装配经 createFigurePipelineGraph 的 initialMeta 传入（'sharp-librsvg'），成功/失败路径
   *  均保留（渲染器执行过即事实，与渲染成败无关）。 */
  readonly renderer: string
  /** 预览 PNG 是否就绪（渲染失败不致命 → false + png 缺省，#744 §3.1）。 */
  readonly previewReady: boolean
  /** 云 API 调用计数（#744 §5.4 成本治理 V1 仅审计）。 */
  readonly cloudCalls: { readonly sam3: number; readonly rmbg: number }
}

// ---------------------------------------------------------------------------
// 阶段面（#744 §5.5 六节点 stage；progress 事件接线归票 4，本票 graph 经 onStage 上报）
// ---------------------------------------------------------------------------

export const FIGURE_STAGES = [
  'generating',
  'segmenting',
  'preparing',
  'templating',
  'assembling',
  'rendering',
] as const

export type FigureStage = (typeof FIGURE_STAGES)[number]

// ---------------------------------------------------------------------------
// 流水线配置（V1 输入面仅 method_text，参数内置常量——#744 Q6）
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  readonly placeholderMode: PlaceholderMode
  /** 步骤 4.6 最大优化迭代数（上游 optimize_iterations 默认 2）。 */
  readonly optimizeIterations: number
  /** SAM3 文本提示（逗号分隔多 prompt；上游 server 侧默认 icon,person,robot,animal）。 */
  readonly samPrompts: readonly string[]
  /** SAM3 最低置信度（上游 min_score 默认 0.5）。 */
  readonly minScore: number
  /** Box 合并阈值（上游 merge_threshold 默认 0.9；0 = 不合并）。 */
  readonly mergeThreshold: number
  /** SAM3 fal 请求 max_masks（上游钳 1..32）。 */
  readonly samMaxMasks: number
}

// 上游 server 侧默认（server.py DEFAULT_SAM_PROMPT 等——实际生产以 server 侧显式传值为准）。
export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  placeholderMode: 'label',
  optimizeIterations: 2,
  samPrompts: ['icon', 'person', 'robot', 'animal'],
  minScore: 0.5,
  mergeThreshold: 0.9,
  samMaxMasks: 32,
}
