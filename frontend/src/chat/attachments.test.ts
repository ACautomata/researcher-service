import { describe, expect, it, vi } from 'vitest'
import { fitWithin, prepareAttachment, validateAttachment, type CompressEngine } from './attachments'

describe('#795 REST 附件采集（S3）', () => {
  it('100MB 文件可发送，第五个附件或超大文件在读取前拒绝', () => {
    const file = new File(['bytes'], 'data.bin')
    Object.defineProperty(file, 'size', { value: 100 * 1024 * 1024, configurable: true })
    expect(validateAttachment(file, 3)).toBeNull()
    expect(validateAttachment(file, 4)).toContain('4')
    Object.defineProperty(file, 'size', { value: 100 * 1024 * 1024 + 1 })
    expect(validateAttachment(file, 0)).toContain('100MB')
  })
  it('文档保留原始 Blob，不读为 base64，空 MIME 按扩展名补齐', async () => {
    const file = new File(['# notes'], 'NOTES.md')
    const prepared = await prepareAttachment(file)
    expect(prepared.blob).toBe(file)
    expect(prepared.mimeType).toBe('text/markdown')
    expect(prepared.fileName).toBe('NOTES.md')
    expect((await prepareAttachment(new File(['data'], 'data.bin'))).mimeType).toBe('application/octet-stream')
  })
  it('图片长边降采样到 1568，上传压缩字节并保留尺寸', async () => {
    const blob = new Blob(['compressed'], { type: 'image/webp' })
    const engine: CompressEngine = {
      loadSize: async () => ({ width: 3136, height: 1568 }),
      render: vi.fn(async () => blob),
    }
    const result = await prepareAttachment(new File(['raw'], 'shot.png', { type: 'image/png' }), engine)
    expect(engine.render).toHaveBeenCalledWith(expect.any(File), 1568, 784, 'image/webp')
    expect(result).toEqual({ blob, fileName: 'shot.png', mimeType: 'image/webp', width: 1568, height: 784 })
    expect(fitWithin(800, 600, 1568)).toEqual({ width: 800, height: 600 })
  })
})
