// seam: chat/attachments —— 附件采集/校验/组装纯函数模块（#459-T1 #462）。
// 契约：采集层（#463 composer 三通道）产生的原始附件 → 类型过滤（白名单 image/audio/video）→
// 体积校验（按字节估算 base64 膨胀，非图片 ≤700KB，图片压缩后同限）→ 组装官方 chat.send 的
// attachments[] 形状。超限附件拒发（返回 rejected 供 UI 提示「文件过大」）；非法输入返回空数组。

import { describe, expect, it } from 'vitest'
import {
  buildAttachments,
  isAllowedAttachmentType,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_BYTES,
  type RawAttachment,
} from './attachments'

// 造字节数可控的 content（base64 体积 = ceil(n/3)*4 决定帧上限，与文件字节数区分）。
// content 用重复字符便于估算 base64 长度（不影响校验逻辑——校验只看字节数）。
function raw(overrides: Partial<RawAttachment> = {}): RawAttachment {
  return {
    mimeType: 'image/png',
    fileName: 'shot.png',
    content: 'a'.repeat(100),
    ...overrides,
  }
}

describe('isAllowedAttachmentType（白名单 image/audio/video）', () => {
  it('放行 image/audio/video 前缀', () => {
    expect(isAllowedAttachmentType('image/png')).toBe(true)
    expect(isAllowedAttachmentType('image/jpeg')).toBe(true)
    expect(isAllowedAttachmentType('image/webp')).toBe(true)
    expect(isAllowedAttachmentType('audio/mpeg')).toBe(true)
    expect(isAllowedAttachmentType('video/mp4')).toBe(true)
  })

  it('拦截非白名单类型（文档等仅发送、渲染层不处理，但仍须挡大字节进帧）', () => {
    expect(isAllowedAttachmentType('application/pdf')).toBe(false)
    expect(isAllowedAttachmentType('text/plain')).toBe(false)
    expect(isAllowedAttachmentType('application/octet-stream')).toBe(false)
    expect(isAllowedAttachmentType('')).toBe(false)
    expect(isAllowedAttachmentType(undefined)).toBe(false)
  })
})

describe('MAX_ATTACHMENT_BYTES（体积上限，base64 膨胀核算）', () => {
  it('非图片 ≤700KB：ceil(716800/3)*4 ≈ 955KB < 1MiB 隧道帧上限，留余量', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(700 * 1024)
    // base64 膨胀 4/3：ceil(716800/3)*4 = 955,734B ≈ 0.91MiB < 1MiB（TUNNEL_MAX_PAYLOAD）
    expect(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4).toBeLessThan(1024 * 1024)
  })

  it('MAX_TOTAL_BYTES（合计预算）：与单附件同值——chat.send 一条 WS 帧，1MiB 上限内', () => {
    expect(MAX_TOTAL_BYTES).toBe(MAX_ATTACHMENT_BYTES)
  })
})

describe('buildAttachments（组装 chat.send attachments[]）', () => {
  it('空输入 → 空数组（不带附件输入时）', () => {
    expect(buildAttachments([])).toEqual({ attachments: [], rejected: [] })
    expect(buildAttachments(undefined)).toEqual({ attachments: [], rejected: [] })
    expect(buildAttachments(null)).toEqual({ attachments: [], rejected: [] })
  })

  it('单个合法附件 → 透传官方字段形状（type/mimeType/fileName/content/sizeBytes/width/height）', () => {
    const out = buildAttachments([
      raw({ type: 'image', sizeBytes: 1234, width: 800, height: 600 }),
    ])
    expect(out.rejected).toEqual([])
    expect(out.attachments).toEqual([
      {
        type: 'image',
        mimeType: 'image/png',
        fileName: 'shot.png',
        content: 'a'.repeat(100),
        sizeBytes: 1234,
        width: 800,
        height: 600,
      },
    ])
  })

  it('多个附件全合法 → 全放行', () => {
    const out = buildAttachments([
      raw({ fileName: 'a.png' }),
      raw({ mimeType: 'audio/mpeg', fileName: 'b.mp3' }),
      raw({ mimeType: 'video/mp4', fileName: 'c.mp4' }),
    ])
    expect(out.attachments).toHaveLength(3)
    expect(out.rejected).toEqual([])
  })

  it('非白名单类型 → 拒发（不进 attachments，进 rejected）', () => {
    const out = buildAttachments([
      raw({ fileName: 'ok.png' }),
      raw({ mimeType: 'application/pdf', fileName: 'doc.pdf' }),
    ])
    expect(out.attachments).toHaveLength(1)
    expect(out.attachments[0].fileName).toBe('ok.png')
    expect(out.rejected).toEqual([
      expect.objectContaining({ fileName: 'doc.pdf', reason: 'type' }),
    ])
  })

  it('超限（>700KB）→ 拒发并标记 size', () => {
    const over = raw({ fileName: 'big.mp4', mimeType: 'video/mp4', content: 'x'.repeat(MAX_ATTACHMENT_BYTES + 1) })
    const out = buildAttachments([over])
    expect(out.attachments).toEqual([])
    expect(out.rejected).toEqual([
      expect.objectContaining({ fileName: 'big.mp4', reason: 'size' }),
    ])
  })

  it('恰在边界（==700KB）→ 放行（base64 后仍 <1MiB）', () => {
    const at = raw({ content: 'x'.repeat(MAX_ATTACHMENT_BYTES) })
    const out = buildAttachments([at])
    expect(out.attachments).toHaveLength(1)
    expect(out.rejected).toEqual([])
  })

  it('混合：合法 + 超类型 + 超体积 → 各归各位', () => {
    const out = buildAttachments([
      raw({ fileName: 'ok.png' }),
      raw({ mimeType: 'application/pdf', fileName: 'doc.pdf' }),
      raw({ fileName: 'big.mp4', mimeType: 'video/mp4', content: 'x'.repeat(MAX_ATTACHMENT_BYTES + 1) }),
    ])
    expect(out.attachments.map((a) => a.fileName)).toEqual(['ok.png'])
    expect(out.rejected.map((r) => ({ name: r.fileName, reason: r.reason }))).toEqual([
      { name: 'doc.pdf', reason: 'type' },
      { name: 'big.mp4', reason: 'size' },
    ])
  })

  it('合计体积超帧预算 → 超出部分拒发（chat.send 帧在一条 WS 帧，合计才决定帧体积）', () => {
    // 每个单附件 ≤700KB 合法，但两个 600KB 合计 1.2MB 超 MAX_TOTAL_BYTES（帧 1MiB 上限留余量）
    const out = buildAttachments([
      raw({ fileName: 'a.png', content: 'x'.repeat(600 * 1024) }),
      raw({ fileName: 'b.png', content: 'y'.repeat(600 * 1024) }),
    ])
    // 先到的放行，后续超合计预算的拒发
    expect(out.attachments.map((a) => a.fileName)).toEqual(['a.png'])
    expect(out.rejected).toEqual([expect.objectContaining({ fileName: 'b.png', reason: 'size' })])
  })

  it('合计恰在预算内 → 全放行', () => {
    const out = buildAttachments([
      raw({ fileName: 'a.png', content: 'x'.repeat(300 * 1024) }),
      raw({ fileName: 'b.png', content: 'y'.repeat(300 * 1024) }),
    ])
    expect(out.attachments).toHaveLength(2)
    expect(out.rejected).toEqual([])
  })

  it('content 为自由形状（0 信任）：字符串/base64 之外的形状不被体积校验误判', () => {
    // content 非 string 时不按 string 长度算，按 sizeBytes（若提供）兜底；均无则视为 0 放行
    const out = buildAttachments([
      raw({ content: { someBlob: true } as unknown as string, sizeBytes: 10 }),
    ])
    expect(out.attachments).toHaveLength(1)
    expect(out.rejected).toEqual([])
  })

  it('缺省可选字段（type/sizeBytes/width/height）→ 透传 undefined（官方 schema 全可选）', () => {
    const out = buildAttachments([raw({ fileName: 'minimal.png' })])
    expect(out.attachments[0]).toEqual({
      type: undefined,
      mimeType: 'image/png',
      fileName: 'minimal.png',
      content: 'a'.repeat(100),
      sizeBytes: undefined,
      width: undefined,
      height: undefined,
    })
  })
})
