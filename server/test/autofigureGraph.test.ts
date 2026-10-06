// AutoFigure 固定 graph 行为单测（#791 · S2 纯逻辑——FigureComputePorts 全 fake）。
// 覆盖 #744 §3.1 失败语义逐点：成功全链 / no_icon 回退链（SAM 无命中 → 像素级 prompt → 保底
// embedded）/ 图标准备失败降级 / 模板生成 no_icon 失败保底 vs 正常失败上抛 / fix ≤3 循环 /
// optimize 迭代（异常 continue、渲染失败 break）/ 渲染失败不致命 / 生图失败 run failed /
// LLM 参数契约（50000/0.7、16000/0.3、50000/0.3）/ 阶段上报 / abort 传播。

import { describe, it, expect } from 'vitest'
import { createFigurePipelineGraph } from '../../plugins/autofigure/pipeline/graph'
import { makeFakePorts, TINY_PNG } from './autofigureFakePorts'

const MODELS = { imageGen: 'img-x', svg: 'svg-x' }
const METHOD = '本文提出 FlowNet-3。'

const GOOD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" width="4" height="4"><g id="AF01"><rect x="0" y="0" width="2" height="2" fill="#808080" stroke="black"/></g></svg>'

function makeGraph() {
  const fakes = makeFakePorts()
  const graph = createFigurePipelineGraph(fakes.ports)
  return { ...fakes, graph }
}

describe('figure pipeline graph（S2 fake ports）', () => {
  it('成功全链：六节点依序执行 → finalSvg/previewPng/meta 聚合', async () => {
    const f = makeGraph()
    f.sam3.detectionsByPrompt.set('icon', [
      { x1: 0, y1: 0, x2: 2, y2: 2, score: 0.9 },
    ])
    f.llm.multimodalReturns.push(GOOD_SVG) // 步骤 4 模板
    f.llm.multimodalReturns.push(GOOD_SVG) // 步骤 4.6 optimize 一轮

    const result = await f.graph.invoke({ methodText: METHOD, models: MODELS })

    expect(result.finalSvg).toContain('<svg')
    expect(result.previewPng).toEqual(TINY_PNG)
    expect(result.noIconMode).toBe(false)
    expect(result.meta.previewReady).toBe(true)
    expect(result.meta.cloudCalls).toEqual({ sam3: 4, rmbg: 1 }) // 默认 4 prompt 逐个检测
    expect(result.meta.optimizeCompleted).toBe(1)
    // 生图 prompt 进 imageGen；模板 prompt 带双图；optimize prompt 带三图
    expect(f.imageGen.calls).toHaveLength(1)
    expect(f.llm.multimodalCalls[0].nImages).toBe(2)
    expect(f.llm.multimodalCalls[1].nImages).toBe(3)
  })

  it('LLM 参数契约：模板 50000/0.7 · optimize 50000/0.3 · fix 16000/0.3', async () => {
    const f = makeGraph()
    f.sam3.detectionsByPrompt.set('icon', [{ x1: 0, y1: 0, x2: 2, y2: 2, score: 0.9 }])
    // 模板首响应带语法错误 → 触发 fix（text 调用）；optimize 一轮
    f.llm.multimodalReturns.push('<svg><rect x="1"</svg>')
    f.llm.textReturns.push(GOOD_SVG)
    f.llm.multimodalReturns.push(GOOD_SVG)

    const result = await f.graph.invoke({ methodText: METHOD, models: MODELS })
    expect(result.meta.fixAttempts).toBe(1)
    expect(f.llm.textCalls[0].opts).toEqual({ maxTokens: 16000, temperature: 0.3 })
    const opts = f.llm.multimodalCalls.map((c) => c.opts)
    expect(opts[0]).toEqual({ maxTokens: 50000, temperature: 0.7 })
    expect(opts[opts.length - 1]).toEqual({ maxTokens: 50000, temperature: 0.3 })
  })

  it('fix 循环 ≤3：LLM 持续返回坏 SVG → 耗尽 3 次返回最后一次，fixAttempts=3', async () => {
    const f = makeGraph()
    f.sam3.detectionsByPrompt.set('icon', [{ x1: 0, y1: 0, x2: 2, y2: 2, score: 0.9 }])
    const BAD = '<svg><rect x="1"</svg>'
    f.llm.multimodalReturns.push(BAD) // 模板（坏）
    f.llm.textReturns.push(BAD, BAD, BAD) // fix 三轮全坏
    // optimize 一轮（渲染 fake 成功）——返回最后 SVG（坏）→ extract 拿到坏 SVG…仍可用（保真上游：不校验产物合法性）

    await f.graph.invoke({ methodText: METHOD, models: MODELS, config: { optimizeIterations: 0 } })
    expect(f.llm.textCalls).toHaveLength(3)
  })

  it('no_icon 回退链：SAM 无命中 → 跳过图标准备 → 像素级复现 prompt → 跳过图标替换', async () => {
    const f = makeGraph()
    // 无任何检测（detectionsByPrompt 空）→ no_icon_mode
    f.llm.multimodalReturns.push(GOOD_SVG)
    f.llm.multimodalReturns.push(GOOD_SVG)

    const result = await f.graph.invoke({ methodText: METHOD, models: MODELS })

    expect(result.noIconMode).toBe(true)
    expect(result.meta.noIconMode).toBe(true)
    expect(f.rmbg.calls).toHaveLength(0) // 图标准备跳过
    expect(f.imageOps.cropCalls).toHaveLength(0)
    // 模板 prompt = 像素级复现（no_icon 变体）
    expect(f.llm.multimodalCalls[0].prompt).toContain('无图标回退模式')
    // 组装直接输出模板（无替换策略链——label 匹配无目标也不追加）
    expect(f.llm.multimodalCalls[0].prompt).not.toContain('PLACEHOLDER STYLE')
  })

  it('no_icon 且模板生成失败 → embedded 保底 SVG（不向上抛，几乎总有产物）', async () => {
    const f = makeGraph()
    f.llm.multimodalReturns.push('no svg here') // 模板提取失败

    const result = await f.graph.invoke({ methodText: METHOD, models: MODELS })

    expect(result.noIconMode).toBe(true)
    expect(result.finalSvg).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
    expect(result.finalSvg).toContain('data:image/png;base64,')
    expect(result.finalSvg.endsWith('</svg>\n')).toBe(true)
  })

  it('非 no_icon 模板生成失败 → run failed（上抛）', async () => {
    const f = makeGraph()
    f.sam3.detectionsByPrompt.set('icon', [{ x1: 0, y1: 0, x2: 2, y2: 2, score: 0.9 }])
    f.llm.multimodalReturns.push('no svg here')

    await expect(f.graph.invoke({ methodText: METHOD, models: MODELS })).rejects.toThrow(
      /no SVG in response/,
    )
  })

  it('图标准备失败 → 降级 no_icon_mode 继续保底链（#744 §3.1）', async () => {
    const f = makeGraph()
    f.sam3.detectionsByPrompt.set('icon', [{ x1: 0, y1: 0, x2: 2, y2: 2, score: 0.9 }])
    f.imageOps.failCrop = true
    f.llm.multimodalReturns.push(GOOD_SVG)

    const result = await f.graph.invoke({ methodText: METHOD, models: MODELS })

    expect(result.noIconMode).toBe(true)
    expect(result.meta.noIconMode).toBe(true)
    expect(result.finalSvg).toContain('<svg')
  })

  it('SAM3 云 API 失败 → run failed（上游 raise 语义）', async () => {
    const f = makeGraph()
    f.sam3.fail = true
    await expect(f.graph.invoke({ methodText: METHOD, models: MODELS })).rejects.toThrow('sam3 failed')
  })

  it('生图失败 → run failed', async () => {
    const f = makeGraph()
    f.imageGen.fail = true
    await expect(f.graph.invoke({ methodText: METHOD, models: MODELS })).rejects.toThrow(
      'image gen failed',
    )
  })

  it('渲染失败不致命：SVG 仍是产物，previewReady=false（#744 §3.1）', async () => {
    const f = makeGraph()
    f.sam3.detectionsByPrompt.set('icon', [{ x1: 0, y1: 0, x2: 2, y2: 2, score: 0.9 }])
    f.llm.multimodalReturns.push(GOOD_SVG)
    f.render.fail = true

    const result = await f.graph.invoke({ methodText: METHOD, models: MODELS })

    expect(result.finalSvg).toContain('<svg')
    expect(result.previewPng).toBeUndefined()
    expect(result.meta.previewReady).toBe(false)
  })

  it('optimize 迭代异常 continue（单轮 LLM throw 不终止循环）；渲染失败 break', async () => {
    // 轮 1 throw（multimodal 空 + 脚本弹性）→ continue；轮 2 成功
    const f = makeGraph()
    f.llm.multimodalReturns.push(GOOD_SVG) // 模板
    f.llm.multimodalReturns.push('') // optimize 轮 1 空响应 → continue
    f.llm.multimodalReturns.push(GOOD_SVG.replace('AF01', 'AF99')) // 轮 2 成功
    f.sam3.detectionsByPrompt.set('icon', [{ x1: 0, y1: 0, x2: 2, y2: 2, score: 0.9 }])

    const result = await f.graph.invoke({ methodText: METHOD, models: MODELS, config: { optimizeIterations: 2 } })
    expect(result.meta.optimizeCompleted).toBe(1) // 仅轮 2 成功
  })

  it('optimize 迭代内 refix 计入 meta.fixAttempts（§5.1 迭代数全量记录）', async () => {
    const f = makeGraph()
    f.sam3.detectionsByPrompt.set('icon', [{ x1: 0, y1: 0, x2: 2, y2: 2, score: 0.9 }])
    f.llm.multimodalReturns.push(GOOD_SVG) // 模板（合法）
    f.llm.multimodalReturns.push('<svg><rect x="1"</svg>') // optimize 轮 1 返回坏 SVG → refix
    f.llm.textReturns.push(GOOD_SVG) // refix 成功

    const result = await f.graph.invoke({ methodText: METHOD, models: MODELS, config: { optimizeIterations: 1 } })
    // 模板首验合法（0 次）+ optimize 内 refix 1 次
    expect(result.meta.fixAttempts).toBe(1)
    expect(result.meta.optimizeCompleted).toBe(1)
  })

  it('meta.renderer 由装配 initialMeta 传入且全程保留（graph 不覆盖渲染器标记）', async () => {
    const f = makeGraph()
    const graph = createFigurePipelineGraph(f.ports, { renderer: 'sharp-librsvg' })
    f.sam3.detectionsByPrompt.set('icon', [{ x1: 0, y1: 0, x2: 2, y2: 2, score: 0.9 }])
    f.llm.multimodalReturns.push(GOOD_SVG)

    const result = await graph.invoke({ methodText: METHOD, models: MODELS })
    expect(result.meta.renderer).toBe('sharp-librsvg')
  })

  it('optimizeIterations=0 → 跳过优化（无 optimize multimodal 调用）', async () => {
    const f = makeGraph()
    f.sam3.detectionsByPrompt.set('icon', [{ x1: 0, y1: 0, x2: 2, y2: 2, score: 0.9 }])
    f.llm.multimodalReturns.push(GOOD_SVG)

    const result = await f.graph.invoke({ methodText: METHOD, models: MODELS, config: { optimizeIterations: 0 } })
    expect(f.llm.multimodalCalls).toHaveLength(1)
    expect(result.meta.optimizeCompleted).toBe(0)
  })

  it('多 prompt 逐个检测合并 + min_score 过滤 + merge（cloudCalls 计数）', async () => {
    const f = makeGraph()
    f.sam3.detectionsByPrompt.set('icon', [
      { x1: 0, y1: 0, x2: 2, y2: 2, score: 0.9 },
      { x1: 0, y1: 0, x2: 2, y2: 2, score: 0.3 }, // < min_score 0.5 → 过滤
    ])
    f.sam3.detectionsByPrompt.set('robot', [{ x1: 0, y1: 0, x2: 3, y2: 3, score: 0.8 }])
    f.llm.multimodalReturns.push(GOOD_SVG)

    const result = await f.graph.invoke({
      methodText: METHOD,
      models: MODELS,
      config: { samPrompts: ['icon', 'robot'], optimizeIterations: 0 },
    })
    expect(f.sam3.calls.map((c) => c.prompt)).toEqual(['icon', 'robot'])
    expect(result.meta.cloudCalls.sam3).toBe(2)
  })

  it('阶段依序上报（六 stage）', async () => {
    const f = makeGraph()
    f.sam3.detectionsByPrompt.set('icon', [{ x1: 0, y1: 0, x2: 2, y2: 2, score: 0.9 }])
    f.llm.multimodalReturns.push(GOOD_SVG)
    const stages: string[] = []
    await f.graph.invoke({ methodText: METHOD, models: MODELS }, { onStage: (s) => stages.push(s) })
    expect(stages).toEqual(['generating', 'segmenting', 'preparing', 'templating', 'assembling', 'rendering'])
  })

  it('abort signal 传播：aborted invoke reject', async () => {
    const f = makeGraph()
    const controller = new AbortController()
    controller.abort()
    await expect(
      f.graph.invoke({ methodText: METHOD, models: MODELS }, { signal: controller.signal }),
    ).rejects.toThrow()
  })
})
