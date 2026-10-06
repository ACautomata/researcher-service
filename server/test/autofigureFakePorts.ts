// AutoFigure 计算 Port 假体（S2 纪律）：graph 单测的确定性注入面。
// 形态对齐（已删）figuresFakePort.ts 先例——输入/输出确定性记录，按脚本步骤返回。

import type {
  FigureComputePorts,
  FigureImageGenPort,
  FigureImageOpsPort,
  FigureLlmPort,
  FigureRmbgPort,
  FigureRenderPort,
  FigureSam3Port,
  LlmCallOptions,
  MultimodalContent,
} from '../../plugins/autofigure/compute/ports'
import type { Sam3Detection } from '../../plugins/autofigure/pipeline/values'
import type { SamBox } from '../../plugins/autofigure/pipeline/values'

// 4x4 灰色 PNG（真实 PNG 字节——sharp 适配器与 fake 共用）
export const TINY_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR42mP8z8AAAxIDEwMDAwMDAwAkBgMBjfAPdAAAAAElFTkSuQmCC',
    'base64',
  ),
)

export class FakeImageGenPort implements FigureImageGenPort {
  readonly calls: { prompt: string; model: string }[] = []
  fail = false
  async generate(prompt: string, model: string) {
    this.calls.push({ prompt, model })
    if (this.fail) throw new Error('image gen failed')
    return { png: TINY_PNG, width: 4, height: 4 }
  }
}

export class FakeLlmPort implements FigureLlmPort {
  readonly textCalls: { prompt: string; model: string; opts: LlmCallOptions }[] = []
  readonly multimodalCalls: {
    prompt: string
    nImages: number
    model: string
    opts: LlmCallOptions
  }[] = []
  /** multimodal 返回脚本：按调用次序弹出（耗尽用 last）。 */
  multimodalReturns: string[] = []
  textReturns: string[] = []
  failText = false

  async text(prompt: string, model: string, opts: LlmCallOptions): Promise<string> {
    this.textCalls.push({ prompt, model, opts })
    if (this.failText) throw new Error('llm text failed')
    return this.textReturns.shift() ?? ''
  }

  async multimodal(
    contents: readonly MultimodalContent[],
    model: string,
    opts: LlmCallOptions,
  ): Promise<string> {
    const first = contents[0]
    this.multimodalCalls.push({
      prompt: typeof first === 'string' ? first : '',
      nImages: contents.filter((c) => typeof c !== 'string').length,
      model,
      opts,
    })
    return this.multimodalReturns.shift() ?? this.multimodalReturns[this.multimodalReturns.length - 1] ?? ''
  }
}

export class FakeSam3Port implements FigureSam3Port {
  readonly calls: { prompt: string; maxMasks: number; width: number; height: number }[] = []
  /** 按 prompt 返回检测（未配置的 prompt → []）。 */
  detectionsByPrompt = new Map<string, readonly Sam3Detection[]>()
  fail = false

  async segment(
    _imageDataUri: string,
    prompt: string,
    maxMasks: number,
    imageWidth: number,
    imageHeight: number,
  ): Promise<readonly Sam3Detection[]> {
    this.calls.push({ prompt, maxMasks, width: imageWidth, height: imageHeight })
    if (this.fail) throw new Error('sam3 failed')
    return this.detectionsByPrompt.get(prompt) ?? []
  }
}

export class FakeRmbgPort implements FigureRmbgPort {
  readonly calls: { inBytes: number }[] = []
  fail = false
  async removeBackground(cropPng: Uint8Array): Promise<Uint8Array> {
    this.calls.push({ inBytes: cropPng.length })
    if (this.fail) throw new Error('rmbg failed')
    return cropPng
  }
}

export class FakeRenderPort implements FigureRenderPort {
  readonly calls: { width: number; height: number }[] = []
  fail = false
  async svgToPng(svg: string, width: number, height: number): Promise<Uint8Array | null> {
    void svg
    this.calls.push({ width, height })
    if (this.fail) return null
    return TINY_PNG
  }
}

export class FakeImageOpsPort implements FigureImageOpsPort {
  readonly cropCalls: { x1: number; y1: number; x2: number; y2: number }[] = []
  readonly drawBoxesCalls: { nBoxes: number }[] = []
  failCrop = false
  async crop(
    png: Uint8Array,
    box: { x1: number; y1: number; x2: number; y2: number },
  ): Promise<Uint8Array> {
    this.cropCalls.push({ ...box })
    if (this.failCrop) throw new Error('crop failed')
    return png
  }
  async upscaleTo4k(png: Uint8Array, targetLongEdge: number) {
    void targetLongEdge
    return { png, upscaled: false }
  }
  async drawBoxes(png: Uint8Array, boxes: readonly SamBox[]): Promise<Uint8Array> {
    this.drawBoxesCalls.push({ nBoxes: boxes.length })
    return png
  }
  async sizeOf(_png: Uint8Array): Promise<{ width: number; height: number }> {
    return { width: 4, height: 4 }
  }
}

export function makeFakePorts(): {
  ports: FigureComputePorts
  imageGen: FakeImageGenPort
  llm: FakeLlmPort
  sam3: FakeSam3Port
  rmbg: FakeRmbgPort
  render: FakeRenderPort
  imageOps: FakeImageOpsPort
} {
  const imageGen = new FakeImageGenPort()
  const llm = new FakeLlmPort()
  const sam3 = new FakeSam3Port()
  const rmbg = new FakeRmbgPort()
  const render = new FakeRenderPort()
  const imageOps = new FakeImageOpsPort()
  return {
    ports: { imageGen, llm, sam3, rmbg, render, imageOps },
    imageGen,
    llm,
    sam3,
    rmbg,
    render,
    imageOps,
  }
}

export const BOX_A: SamBox = {
  id: 0,
  label: '<AF>01',
  x1: 0,
  y1: 0,
  x2: 2,
  y2: 2,
  score: 0.9,
  prompt: 'icon',
}
