// #795 REST 附件采集：字节以 Blob 上传，消息只携带 attachmentId。
import type { AttachmentMeta } from '@/api/sessions'

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_MESSAGE = 4
export const MAX_IMAGE_EDGE = 1568

export interface PreparedAttachment {
  blob: Blob
  fileName: string
  mimeType: string
  width?: number
  height?: number
}
export interface PendingAttachment {
  key: number
  att: PreparedAttachment
  previewUrl: string
  uploaded?: AttachmentMeta
}
export interface CompressEngine {
  loadSize(file: File): Promise<{ width: number; height: number }>
  render(file: File, width: number, height: number, mime: string): Promise<Blob>
}

export function validateAttachment(file: Pick<File, 'size'>, count: number): string | null {
  if (count >= MAX_ATTACHMENTS_PER_MESSAGE) return '单消息最多 4 个附件'
  if (file.size > MAX_ATTACHMENT_BYTES) return '单文件不能超过 100MB'
  return null
}

export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const scale = Math.min(1, max / Math.max(w, h))
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

const EXT_MIME: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml',
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
  json: 'application/json', pdf: 'application/pdf', zip: 'application/zip',
}

export async function prepareAttachment(file: File, engine: CompressEngine = canvasEngine): Promise<PreparedAttachment> {
  const error = validateAttachment(file, 0)
  if (error) throw new Error(error)
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const mimeType = file.type || EXT_MIME[ext] || 'application/octet-stream'
  if (!mimeType.startsWith('image/')) return { blob: file, fileName: file.name, mimeType }
  const size = await engine.loadSize(file)
  const target = fitWithin(size.width, size.height, MAX_IMAGE_EDGE)
  const blob = await engine.render(file, target.width, target.height, 'image/webp')
  if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error('单文件不能超过 100MB')
  return { blob, fileName: file.name, mimeType: blob.type, ...target }
}

function decodeImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => { URL.revokeObjectURL(url); resolve(image) }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')) }
    image.src = url
  })
}
const canvasEngine: CompressEngine = {
  async loadSize(file) {
    const image = await decodeImage(file)
    return { width: image.naturalWidth, height: image.naturalHeight }
  },
  async render(file, width, height, mime) {
    const image = await decodeImage(file)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('图片处理不可用')
    context.drawImage(image, 0, 0, width, height)
    return new Promise((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('图片处理失败')), mime, 0.85,
    ))
  },
}
