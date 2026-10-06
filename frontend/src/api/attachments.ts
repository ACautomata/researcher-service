import { apiFetch, ApiError, parseEnvelopeBody } from './client'

// 二进制成功面有 Content-Disposition；JSON 附件不能误判为错误信封。
export async function readAttachmentBlob(id: string, signal?: AbortSignal): Promise<Blob> {
  const response = await apiFetch(`/api/v1/attachments/${encodeURIComponent(id)}/download`, { signal, timeoutMs: 300_000 })
  if (response.headers.get('Content-Type')?.includes('application/json') && !response.headers.get('Content-Disposition')) {
    const envelope = await parseEnvelopeBody(response) as { code?: number; message?: string } | null
    throw new ApiError(response.status, envelope?.message || '附件不可用', envelope?.code)
  }
  if (!response.ok) throw new ApiError(response.status, '附件下载失败')
  return response.blob()
}
