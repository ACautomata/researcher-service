// AutoFigure SAM3 解析 / box 合并 / boxlib 构造（#791 · S2 纯逻辑单测）。
// 上游对照：autofigure2.py _extract_sam3_api_detections / _extract_roboflow_detections /
// merge_overlapping_boxes / segment_with_sam3 尾段（buildValidBoxes/buildBoxlib）。

import { describe, it, expect } from 'vitest'
import {
  cxcywhNormToXyxy,
  polygonToBbox,
  extractFalDetections,
  extractRoboflowDetections,
  calculateOverlapRatio,
  mergeOverlappingBoxes,
  buildValidBoxes,
  buildBoxlib,
} from '../../plugins/autofigure/pipeline/sam3Parse'

describe('cxcywhNormToXyxy（fal 归一化坐标换算）', () => {
  it('归一化中心/宽高 → 像素 xyxy', () => {
    // cx=0.25,cy=0.25,bw=0.5,bh=0.5 on 200x120 → cx=50,cy=30,bw=100,bh=60 → (0,0,100,60)
    expect(cxcywhNormToXyxy([0.25, 0.25, 0.5, 0.5], 200, 120)).toEqual([0, 0, 100, 60])
  })

  it('越界钳制 → 零宽 box → null（与上游 None 语义一致）', () => {
    // cx=1.2*200=240 bw=0.4*200=80 → x1=clamp(200)=200, x2=clamp(280)=200 → 200<=200 → None
    expect(cxcywhNormToXyxy([1.2, 0.5, 0.4, 1.5], 200, 120)).toBeNull()
  })

  it('零宽/零高 box → null', () => {
    expect(cxcywhNormToXyxy([0.5, 0.5, 0.0, 0.5], 200, 120)).toBeNull()
    expect(cxcywhNormToXyxy([0.5, 0.5, 0.5, 0.0], 200, 120)).toBeNull()
  })

  it('少于 4 元素 / 非数值 → null（float(v) TypeError 语义）', () => {
    expect(cxcywhNormToXyxy([0.1, 0.2, 0.3], 200, 120)).toBeNull()
    expect(cxcywhNormToXyxy([0.1, null, 0.3, 0.4], 200, 120)).toBeNull()
    expect(cxcywhNormToXyxy([[1], 0.2, 0.3, 0.4], 200, 120)).toBeNull()
  })
})

describe('polygonToBbox（roboflow polygon → bbox）', () => {
  it('多边形取最小包围盒', () => {
    expect(polygonToBbox([[10, 20], [80, 20], [80, 90], [10, 90]], 200, 120)).toEqual([10, 20, 80, 90])
  })
  it('空点集 / 非法点跳过', () => {
    expect(polygonToBbox([], 200, 120)).toBeNull()
    expect(polygonToBbox([[1, 2]], 200, 120)).toBeNull() // 单点 → 零面积 → 与上游一致丢弃
  })
})

describe('extractFalDetections', () => {
  it('metadata 形状（fal 新形态）→ detections；零宽 box 丢弃', () => {
    const resp = {
      metadata: [
        { box: [0.2, 0.25, 0.3, 0.5], score: 0.93 },
        { box: [0.5, 0.5, 0.0, 0.5], score: 0.9 },
      ],
    }
    expect(extractFalDetections(resp, 200, 120)).toEqual([
      { x1: 10, y1: 0, x2: 70, y2: 60, score: 0.93 },
    ])
  })

  it('boxes+scores 形状（fal 旧形态）；scores 缺位 → null', () => {
    const resp = { boxes: [[0.25, 0.25, 0.5, 0.5], [0.75, 0.5, 0.1, 0.2]], scores: [0.88] }
    expect(extractFalDetections(resp, 200, 120)).toEqual([
      { x1: 0, y1: 0, x2: 100, y2: 60, score: 0.88 },
      { x1: 140, y1: 48, x2: 160, y2: 72, score: null }, // cy=60 bh=24 → y1=48 y2=72
    ])
  })

  it('非对象输入 → []', () => {
    expect(extractFalDetections(null, 200, 120)).toEqual([])
    expect(extractFalDetections('x', 200, 120)).toEqual([])
  })
})

describe('extractRoboflowDetections（polygon 形状三嵌套归一）', () => {
  it('predictions[].masks 平铺与嵌套点集', () => {
    const resp = {
      prompt_results: [
        {
          predictions: [
            { confidence: 0.81, masks: [[[10, 20], [80, 20], [80, 90], [10, 90]]] },
            { confidence: 0.6, masks: [[[5, 5], [40, 5], [40, 40]]] },
          ],
        },
      ],
    }
    expect(extractRoboflowDetections(resp, 200, 120)).toEqual([
      { x1: 10, y1: 20, x2: 80, y2: 90, score: 0.81 },
      { x1: 5, y1: 5, x2: 40, y2: 40, score: 0.6 },
    ])
  })
  it('无 prompt_results → []', () => {
    expect(extractRoboflowDetections({}, 200, 120)).toEqual([])
  })
})

describe('box 合并（overlap ratio / merge）', () => {
  const A = { id: 0, label: '<AF>01', x1: 0, y1: 0, x2: 100, y2: 100, score: 0.9, prompt: 'icon' }
  const B = { id: 1, label: '<AF>02', x1: 5, y1: 5, x2: 105, y2: 105, score: 0.7, prompt: 'robot' }
  const C = { id: 2, label: '<AF>03', x1: 200, y1: 200, x2: 260, y2: 260, score: 0.6, prompt: 'person' }

  it('重叠比例 = 交集 / 较小面积', () => {
    // 交集 (5,5,100,100)=95*95=9025；min area=100*100=10000 → 0.9025
    expect(calculateOverlapRatio(A, B)).toBeCloseTo(0.9025, 6)
  })
  it('无交集 → 0', () => {
    expect(calculateOverlapRatio(A, C)).toBe(0)
  })

  it('merge ≥ 阈值：最小包围矩形 + 高分保留 + 异 prompt 取高分侧 + 重新编号', () => {
    const merged = mergeOverlappingBoxes([A, B, C], 0.9)
    expect(merged).toHaveLength(2)
    // 上游顺序：合并结果 append 到末尾——C 前移为 01
    expect(merged[0]).toMatchObject({ id: 0, label: '<AF>01', x1: 200, score: 0.6, prompt: 'person' })
    // A∪B 最小包围矩形：(0,0,105,105)，score 0.9，prompt 取 A（icon 高分侧）
    expect(merged[1]).toEqual({
      id: 1, label: '<AF>02', x1: 0, y1: 0, x2: 105, y2: 105, score: 0.9, prompt: 'icon',
    })
  })

  it('低于阈值不合并', () => {
    expect(mergeOverlappingBoxes([A, C], 0.9)).toHaveLength(2)
  })
  it('阈值 0 / 单 box → 原样', () => {
    expect(mergeOverlappingBoxes([A, B], 0)).toHaveLength(2)
    expect(mergeOverlappingBoxes([A], 0.9)).toHaveLength(1)
  })
})

describe('buildValidBoxes（min_score 过滤 → 编号 → 合并）', () => {
  it('逐 prompt 检测合并、低分过滤、label 分配 <AF>{i+1:02d}', () => {
    const boxes = buildValidBoxes(
      [
        { prompt: 'icon', detections: [{ x1: 0, y1: 0, x2: 10, y2: 10, score: 0.9 }, { x1: 50, y1: 50, x2: 60, y2: 60, score: 0.3 }] },
        { prompt: 'robot', detections: [{ x1: 100, y1: 0, x2: 120, y2: 20, score: 0.8 }] },
      ],
      0.5,
      0.9,
    )
    expect(boxes).toEqual([
      { id: 0, label: '<AF>01', x1: 0, y1: 0, x2: 10, y2: 10, score: 0.9, prompt: 'icon' },
      { id: 1, label: '<AF>02', x1: 100, y1: 0, x2: 120, y2: 20, score: 0.8, prompt: 'robot' },
    ])
  })
})

describe('buildBoxlib（上游 boxlib_data 字典形状）', () => {
  it('image_size/prompts_used/boxes/no_icon_mode', () => {
    const lib = buildBoxlib(200, 120, ['icon'], [
      { id: 0, label: '<AF>01', x1: 0, y1: 0, x2: 10, y2: 10, score: 0.9, prompt: 'icon' },
    ])
    expect(lib).toEqual({
      image_size: { width: 200, height: 120 },
      prompts_used: ['icon'],
      boxes: [{ id: 0, label: '<AF>01', x1: 0, y1: 0, x2: 10, y2: 10, score: 0.9, prompt: 'icon' }],
      no_icon_mode: false,
    })
  })
  it('空 boxes → no_icon_mode=true', () => {
    expect(buildBoxlib(200, 120, ['icon'], []).no_icon_mode).toBe(true)
  })
})
