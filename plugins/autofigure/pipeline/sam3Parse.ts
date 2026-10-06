// SAM3 检测解析 + box 合并 + boxlib 构造（#791 · 上游 autofigure2.py 逐字直译）。
// 上游对照：ResearAI/AutoFigure-Edit @ 16f3749（MIT derivative work，见 NOTICE.md）。
// 行号注记 = 上游源码位置。这些函数是纯逻辑（JSON/数值/字符串），golden-file 对照面。

import type { Boxlib, SamBox, Sam3Detection } from './values'

// ---------------------------------------------------------------------------
// 坐标换算（上游 _cxcywh_norm_to_xyxy :1618-1643 / _polygon_to_bbox :1646-1676）
// ---------------------------------------------------------------------------

// Python float(v) 等价解析：number/string 可转，null/undefined/数组/对象 → null
//（float(None)/float([]) 抛 TypeError；Number(null)===0 的 JS 语义不保真）。
function pyFloat(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isNaN(n) ? null : n
  }
  return null
}

// fal cxcywh 归一化坐标 → 像素 xyxy（越界钳制 + 零面积丢弃）。无效 → null。
export function cxcywhNormToXyxy(
  box: readonly unknown[],
  width: number,
  height: number,
): [number, number, number, number] | null {
  if (!box || box.length < 4) return null
  const nums: number[] = []
  for (let i = 0; i < 4; i++) {
    const v = pyFloat(box[i])
    if (v === null) return null
    nums.push(v)
  }
  const cx = nums[0] * width
  const cy = nums[1] * height
  const bw = nums[2] * width
  const bh = nums[3] * height

  const x1 = clampInt(pyRound(cx - bw / 2.0), width)
  const y1 = clampInt(pyRound(cy - bh / 2.0), height)
  const x2 = clampInt(pyRound(cx + bw / 2.0), width)
  const y2 = clampInt(pyRound(cy + bh / 2.0), height)

  if (x2 <= x1 || y2 <= y1) return null
  return [x1, y1, x2, y2]
}

// Python round() 是 banker's rounding（.5 向偶数舍入）；JS Math.round .5 向 +∞。
// 上游经 int(round(x))，此处对齐 banker's rounding 保真（golden 对照相依赖）。
export function pyRound(x: number): number {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

function clampInt(v: number, bound: number): number {
  return Math.max(0, Math.min(bound, v))
}

export function polygonToBbox(
  points: readonly unknown[],
  width: number,
  height: number,
): [number, number, number, number] | null {
  const xs: number[] = []
  const ys: number[] = []
  for (const pt of points) {
    if (!Array.isArray(pt) || pt.length < 2) continue
    const x = pyFloat(pt[0])
    const y = pyFloat(pt[1])
    if (x === null || y === null) continue
    xs.push(x)
    ys.push(y)
  }
  if (xs.length === 0 || ys.length === 0) return null
  const x1 = clampInt(pyRound(Math.min(...xs)), width)
  const y1 = clampInt(pyRound(Math.min(...ys)), height)
  const x2 = clampInt(pyRound(Math.max(...xs)), width)
  const y2 = clampInt(pyRound(Math.max(...ys)), height)
  if (x2 <= x1 || y2 <= y1) return null
  return [x1, y1, x2, y2]
}

// ---------------------------------------------------------------------------
// 响应解析（上游 _extract_sam3_api_detections :1679-1711 / _extract_roboflow_detections :1714+）。
// fal 为现役适配器；roboflow 解析保留为 Sam3Port 换形态资产（#744 §9「计算 Port 保持可换，
// 每个云步骤一个 Port 接缝」+ §6 凭证表 fal/Roboflow 二出口）。
// ---------------------------------------------------------------------------

export function extractFalDetections(
  responseJson: unknown,
  width: number,
  height: number,
): Sam3Detection[] {
  const detections: Sam3Detection[] = []
  if (typeof responseJson !== 'object' || responseJson === null) return detections
  const resp = responseJson as Record<string, unknown>

  // 形状 1：metadata[]（fal 新形态，box = cxcywh 归一化）
  const metadata = resp.metadata
  if (Array.isArray(metadata) && metadata.length > 0) {
    for (const item of metadata) {
      if (typeof item !== 'object' || item === null) continue
      const xyxy = cxcywhNormToXyxy((item as Record<string, unknown>).box as readonly unknown[], width, height)
      if (!xyxy) continue
      const score = (item as Record<string, unknown>).score
      detections.push({
        x1: xyxy[0],
        y1: xyxy[1],
        x2: xyxy[2],
        y2: xyxy[3],
        score: typeof score === 'number' ? score : null,
      })
    }
    return detections
  }

  // 形状 2：boxes[] + scores[]（fal 旧形态）
  const boxes = resp.boxes
  const scores = resp.scores
  if (Array.isArray(boxes) && boxes.length > 0) {
    const scoresList = Array.isArray(scores) ? scores : []
    boxes.forEach((box, idx) => {
      const xyxy = cxcywhNormToXyxy(box as readonly unknown[], width, height)
      if (!xyxy) return
      const score: unknown = idx < scoresList.length ? scoresList[idx] : null
      detections.push({
        x1: xyxy[0],
        y1: xyxy[1],
        x2: xyxy[2],
        y2: xyxy[3],
        score: typeof score === 'number' ? score : null,
      })
    })
  }
  return detections
}

export function extractRoboflowDetections(
  responseJson: unknown,
  width: number,
  height: number,
): Sam3Detection[] {
  const detections: Sam3Detection[] = []
  if (typeof responseJson !== 'object' || responseJson === null) return detections
  const promptResults = (responseJson as Record<string, unknown>).prompt_results
  if (!Array.isArray(promptResults)) return detections

  for (const promptResult of promptResults) {
    if (typeof promptResult !== 'object' || promptResult === null) continue
    const predictions = (promptResult as Record<string, unknown>).predictions
    if (!Array.isArray(predictions)) continue
    for (const prediction of predictions) {
      if (typeof prediction !== 'object' || prediction === null) continue
      const pred = prediction as Record<string, unknown>
      const confidence: unknown = pred.confidence
      const masks = pred.masks
      if (!Array.isArray(masks)) continue
      for (const mask of masks) {
        const points = flattenMaskPoints(mask)
        if (points.length === 0) continue
        const xyxy = polygonToBbox(points, width, height)
        if (!xyxy) continue
        detections.push({
          x1: xyxy[0],
          y1: xyxy[1],
          x2: xyxy[2],
          y2: xyxy[3],
          score: typeof confidence === 'number' ? confidence : null,
        })
      }
    }
  }
  return detections
}

// 上游 mask 点集归一（:1736-1755）：[[x,y],...] 平铺 / [[ [x,y],... ],...] 嵌套一层/两层。
function flattenMaskPoints(mask: unknown): unknown[][] {
  const points: unknown[][] = []
  if (Array.isArray(mask) && mask.length > 0) {
    const first = mask[0]
    if (Array.isArray(first) && first.length >= 2 && typeof first[0] === 'number') {
      return mask as unknown[][]
    }
    if (Array.isArray(first)) {
      for (const sub of first) {
        if (Array.isArray(sub) && sub.length >= 2 && typeof sub[0] === 'number') {
          points.push(sub)
        } else if (Array.isArray(sub) && sub.length > 0 && Array.isArray(sub[0])) {
          for (const pt of sub as unknown[]) {
            if (Array.isArray(pt) && pt.length >= 2) points.push(pt)
          }
        }
      }
    }
  }
  return points
}

// ---------------------------------------------------------------------------
// box 合并（上游 calculate_overlap_ratio :1459-1491 / merge_two_boxes :1494-1527 /
// merge_overlapping_boxes :1528-1586）
// ---------------------------------------------------------------------------

// 重叠比例 = 交集面积 / 较小 box 面积（无交集/零面积 → 0）。
export function calculateOverlapRatio(a: SamBox | MergableBox, b: SamBox | MergableBox): number {
  const x1 = Math.max(a.x1, b.x1)
  const y1 = Math.max(a.y1, b.y1)
  const x2 = Math.min(a.x2, b.x2)
  const y2 = Math.min(a.y2, b.y2)
  if (x2 <= x1 || y2 <= y1) return 0.0
  const intersection = (x2 - x1) * (y2 - y1)
  const area1 = (a.x2 - a.x1) * (a.y2 - a.y1)
  const area2 = (b.x2 - b.x1) * (b.y2 - b.y1)
  if (area1 === 0 || area2 === 0) return 0.0
  return intersection / Math.min(area1, area2)
}

interface MergableBox {
  x1: number
  y1: number
  x2: number
  y2: number
  score: number
  prompt?: string
}

// 最小包围矩形合并 + 较高置信度保留 + prompt 归属（同 prompt 保留 / 异 prompt 取高分侧）。
export function mergeTwoBoxes(box1: MergableBox, box2: MergableBox): MergableBox {
  const merged: MergableBox = {
    x1: Math.min(box1.x1, box2.x1),
    y1: Math.min(box1.y1, box2.y1),
    x2: Math.max(box1.x2, box2.x2),
    y2: Math.max(box1.y2, box2.y2),
    score: Math.max(box1.score, box2.score),
  }
  const prompt1 = box1.prompt ?? ''
  const prompt2 = box2.prompt ?? ''
  if (prompt1 && prompt2) {
    if (prompt1 === prompt2) {
      merged.prompt = prompt1
    } else {
      merged.prompt = box1.score >= box2.score ? prompt1 : prompt2
    }
  } else if (prompt1) {
    merged.prompt = prompt1
  } else if (prompt2) {
    merged.prompt = prompt2
  }
  return merged
}

// 迭代合并：任一对重叠 ≥ threshold → 合并并重扫（上游 while merged 双层循环直译）；末尾
// 重新编号（label = <AF>{idx+1:02d}）。
export function mergeOverlappingBoxes(boxes: readonly SamBox[], overlapThreshold: number): SamBox[] {
  if (overlapThreshold <= 0 || boxes.length <= 1) return [...boxes]

  const working: MergableBox[] = boxes.map((b) => ({ ...b }))
  let merged = true
  while (merged) {
    merged = false
    const n = working.length
    for (let i = 0; i < n; i++) {
      if (merged) break
      for (let j = i + 1; j < n; j++) {
        const ratio = calculateOverlapRatio(working[i], working[j])
        if (ratio >= overlapThreshold) {
          const newBox = mergeTwoBoxes(working[i], working[j])
          working.splice(j, 1)
          working.splice(i, 1)
          working.push(newBox)
          merged = true
          break
        }
      }
    }
  }

  // 重新编号（上游 :1569-1584）
  return working.map((box, idx) => ({
    id: idx,
    label: `<AF>${String(idx + 1).padStart(2, '0')}`,
    x1: box.x1,
    y1: box.y1,
    x2: box.x2,
    y2: box.y2,
    score: box.score,
    prompt: box.prompt ?? '',
  }))
}

// ---------------------------------------------------------------------------
// 检测 → valid_boxes → boxlib（上游 segment_with_sam3 :2063-2145 尾段直译；min_score 过滤
// 与逐 prompt 检测循环在 graph 节点层，此处收口纯数据面）
// ---------------------------------------------------------------------------

// 逐 prompt 检测的原始检测（像素坐标 + 来源 prompt）→ min_score 过滤 → 编号 → 合并。
// 上游顺序：全部 prompt 检测完 → min_score 过滤入 all_detected_boxes（检测时即过滤）→
// 统一编号 → merge。本函数输入 = 各 prompt 已过滤的检测序列。
export function buildValidBoxes(
  perPromptDetections: readonly { readonly prompt: string; readonly detections: readonly Sam3Detection[] }[],
  minScore: number,
  mergeThreshold: number,
): SamBox[] {
  const all: MergableBox[] = []
  for (const { prompt, detections } of perPromptDetections) {
    for (const det of detections) {
      const scoreVal = det.score ?? 0.0
      if (scoreVal >= minScore) {
        all.push({ x1: det.x1, y1: det.y1, x2: det.x2, y2: det.y2, score: scoreVal, prompt })
      }
    }
  }
  // 初次编号（上游 :2063-2074）
  let validBoxes: SamBox[] = all.map((boxData, i) => ({
    id: i,
    label: `<AF>${String(i + 1).padStart(2, '0')}`,
    x1: boxData.x1,
    y1: boxData.y1,
    x2: boxData.x2,
    y2: boxData.y2,
    score: boxData.score,
    prompt: boxData.prompt ?? '',
  }))
  if (mergeThreshold > 0 && validBoxes.length > 1) {
    validBoxes = mergeOverlappingBoxes(validBoxes, mergeThreshold)
  }
  return validBoxes
}

export function buildBoxlib(
  width: number,
  height: number,
  promptsUsed: readonly string[],
  validBoxes: readonly SamBox[],
): Boxlib {
  return {
    image_size: { width, height },
    prompts_used: [...promptsUsed],
    boxes: validBoxes,
    no_icon_mode: validBoxes.length === 0,
  }
}
