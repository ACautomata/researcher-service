// AutoFigure 计算 Port（#791 票 2 · #744 §0.3/§3.1/§5.4/§6）。
//
// 边界纪律：Port 是「纯计算接缝」——graph 节点经此消费 LLM/云 API/图像操作，全部可 fake
//（S2 纪律）。Port 不拥有持久化/生命周期/幂等/归属（#744 §5.2 归 run 域）。
// 凭证纪律（#744 §6）：env 注入、不落盘、不入日志、不进事件载荷——适配器构造期收凭证，
// 调用面不透传任何 key（与旧 AutoFigureGenerationPort 的 input/credential 分离同型）。
//
// Port 面（#744 §10 票 2「SAM3/RMBG/渲染 Port + fal 适配器」+ §0.3 裁切/4K 放大 = TS 原生
// sharp）：
//   FigureImageGenPort  —— 步骤 1 生图（面板级 AUTOFIGURE_* 配置的服务端出口）
//   FigureLlmPort       —— 步骤 4/4.5/4.6 多模态与文本（生产适配 = 票 4 ctx.llm 句柄）
//   FigureSam3Port      —— 步骤 2 SAM3 云 API（fal 适配器，本票交付）
//   FigureRmbgPort      —— 步骤 3 去背景云 API（fal 适配器，本票交付）
//   FigureRenderPort    —— SVG→PNG（sharp/librsvg 适配器，本票交付）
//   FigureImageOpsPort  —— 图像原生操作（裁切/4K 放大/samed 标记图合成；sharp 适配器）

// ---------------------------------------------------------------------------
// 基础形状
// ---------------------------------------------------------------------------

import type { Sam3Detection, SamBox } from '../pipeline/values'
import type { PluginLlmCallOptions, PluginLlmContent } from '../../../server/src/plugins/api'

export interface FigureImage {
  readonly png: Uint8Array
  readonly width: number
  readonly height: number
}

// 多模态 contents：文本与 PNG 图混合序列（上游 call_llm_multimodal contents 形状）。
// 单源 = 核心 ctx.llm 载荷 PluginLlmContent（别名不另立形状，消除同形定义两对——插件→核心
// 方向直引合法，同 server.ts/dataUri.ts 先例）。
export type MultimodalContent = PluginLlmContent

// LLM 调用参数（上游契约：步骤 4 max_tokens=50000/temp=0.7；4.5 fix 16000/0.3；
// 4.6 optimize 50000/0.3——参数由 graph 节点显式传，适配器不自带默认）。单源 = 核心
// PluginLlmCallOptions。
export type LlmCallOptions = PluginLlmCallOptions

// ---------------------------------------------------------------------------
// 各步骤 Port
// ---------------------------------------------------------------------------

export interface FigureImageGenPort {
  /** 步骤 1 生图：method prompt → PNG。失败即 run failed（上游 raise 语义）。 */
  generate(prompt: string, model: string): Promise<FigureImage>
}

export interface FigureLlmPort {
  /** 文本调用（步骤 4.5 fix 循环）。 */
  text(prompt: string, model: string, opts: LlmCallOptions): Promise<string>
  /** 多模态调用（步骤 4 / 4.6；图 = PNG data URI 形态由适配器编码）。 */
  multimodal(
    contents: readonly MultimodalContent[],
    model: string,
    opts: LlmCallOptions,
  ): Promise<string>
}


export interface FigureSam3Port {
  /** 单 prompt 一次检测（多 prompt 循环在节点层——上游逐 prompt 检测合并）。
   * width/height = 原图像素（归一化坐标换算基准，上游 _extract_sam3_api_detections 形参）。 */
  segment(
    imageDataUri: string,
    prompt: string,
    maxMasks: number,
    imageWidth: number,
    imageHeight: number,
  ): Promise<readonly Sam3Detection[]>
}

export interface FigureRmbgPort {
  /** 去背景：裁切 PNG → 透明背景 PNG。 */
  removeBackground(cropPng: Uint8Array): Promise<Uint8Array>
}

export interface FigureRenderPort {
  /** SVG 文本 → PNG。失败不致命（返回 null——预览缺省 + meta 标记，#744 §3.1）。 */
  svgToPng(svg: string, width: number, height: number): Promise<Uint8Array | null>
}

export interface FigureImageOpsPort {
  /** PIL crop 等价：像素矩形裁切（步骤 3）。 */
  crop(png: Uint8Array, box: { x1: number; y1: number; x2: number; y2: number }): Promise<Uint8Array>
  /** 4K 等比放大（步骤 1 后；长边 < 4096 才放大，返回 {png, upscaled}）。 */
  upscaleTo4k(png: Uint8Array, targetLongEdge: number): Promise<{ png: Uint8Array; upscaled: boolean }>
  /** samed 标记图（步骤 2 产物）：原图 + 灰框(#808080)/黑边(3)/白 label 覆盖层。 */
  drawBoxes(png: Uint8Array, boxes: readonly SamBox[]): Promise<Uint8Array>
  /** 读取图像尺寸（boxlib.image_size / SVG 对照面）。 */
  sizeOf(png: Uint8Array): Promise<{ width: number; height: number }>
}

// ---------------------------------------------------------------------------
// graph 依赖聚合（createFigurePipelineGraph 单注入面）
// ---------------------------------------------------------------------------

export interface FigureComputePorts {
  readonly imageGen: FigureImageGenPort
  readonly llm: FigureLlmPort
  readonly sam3: FigureSam3Port
  readonly rmbg: FigureRmbgPort
  readonly render: FigureRenderPort
  readonly imageOps: FigureImageOpsPort
}
