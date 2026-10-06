// AutoFigure 域 API client（#791 · #744 v2 §7/§8 读面收缩后形状）。
// figures REST 读面（资产常驻）：GET /（列表）· GET /:id（详情）· GET /:id/png（PNG 字节）·
// GET /:id/svg（SVG 文本）。生成入口 = 会话内 figure 工具（#744 §4.1/Q10），REST 创建端点
// 已随 GenerationJob 退役——本模块不导出任何创建/删除函数。
// 边界纪律：
//   - PNG/SVG 走 apiFetch（原始响应，成功路径豁免 #312 信封 → 原生字节直发）；错误面仍走信封
//     （70040/70043，HTTP 200 + JSON），按 Content-Type 判别。apiJson 是信封解析器，读产物
//     字节会失败，故不可用。
//   - SVG 渲染由消费组件经 <img> blob URL 装载（脚本不执行，#744 §4.2）；本模块只拉取 Blob。
import { ApiError, apiFetch, apiJson, parseEnvelopeBody } from '@/api/client'
import { parseEnvelope } from '@/api/errors'

export interface FigureSummaryDTO {
  readonly figureId: string
  readonly prompt: string
  readonly sessionId: string | null
  readonly createdAt: string
}

export interface FigureDetailDTO extends FigureSummaryDTO {
  readonly previewReady: boolean
  readonly updatedAt: string
}

// 后端排序已冻结（T05 沿革）：createdAt DESC, id DESC。客户端不重排、不分页、不搜索。
export function listFigures(): Promise<FigureSummaryDTO[]> {
  return apiJson<FigureSummaryDTO[]>('/api/v1/figures')
}

export function getFigureDetail(id: string): Promise<FigureDetailDTO> {
  return apiJson<FigureDetailDTO>(`/api/v1/figures/${encodeURIComponent(id)}`)
}

// 产物读路径共用：成功（image/* 直发，豁免信封）→ Blob；错误（JSON 信封）→ ApiError（70040
// 不存在越权 / 70043 产物缺失）。apiFetch 复用既有 JWT + 401 刷新链，不建第二 fetch 栈。
async function artifactBlob(path: string): Promise<Blob> {
  const resp = await apiFetch(path)
  const contentType = resp.headers.get('content-type') ?? ''
  if (contentType.startsWith('image/')) {
    return resp.blob()
  }
  // parseEnvelopeBody 复用 apiFetch 可能已读并缓存的同一 body（__envBody）——body 流只可读
  // 一次，二次 resp.json() 会 reject 丢码。
  const env = parseEnvelope(await parseEnvelopeBody(resp))
  if (env) throw new ApiError(resp.status, env.message || `请求失败（${resp.status}）`, env.code)
  throw new ApiError(resp.status, `请求失败（${resp.status}）`)
}

// PNG 原始字节（下载契约沿 T06）：成功路径原生 image/png（不包信封、不 base64-in-JSON）。
export function getFigurePngBlob(id: string): Promise<Blob> {
  return artifactBlob(`/api/v1/figures/${encodeURIComponent(id)}/png`)
}

// SVG 产物（#744 §4.2/§7）：前端经 blob URL（<img> 或下载链接）消费。download=true 追加
// ?download=1（服务端置 Content-Disposition: attachment）。
export function getFigureSvgBlob(id: string, download = false): Promise<Blob> {
  const q = download ? '?download=1' : ''
  return artifactBlob(`/api/v1/figures/${encodeURIComponent(id)}/svg${q}`)
}
