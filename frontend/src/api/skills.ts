// Skill 市场 REST client（#1058 D 票 · #1056 B 票契约）：upload(multipart)/list/detail/
// download/delete/enablement。D5 类别枚举前端单源（与 server skills/values.ts SKILL_CATEGORIES
// 同值——枚举外 category 由 B 票 80002 结构化拒收兜底）。
import { apiFetch, apiJson, ApiError, parseEnvelopeBody } from './client'
import { parseEnvelope } from './errors'

export const SKILL_CATEGORIES = ['research', 'writing', 'data', 'literature', 'other'] as const
export type SkillCategory = (typeof SKILL_CATEGORIES)[number]

export const SKILL_CATEGORY_LABELS: Readonly<Record<SkillCategory, string>> = {
  research: '研究方法',
  writing: '论文写作',
  data: '数据分析',
  literature: '文献工具',
  other: '其他',
}

export interface SkillMarketItem {
  id: string
  name: string
  description: string
  category: string
  uploaderName: string
  fileCount: number
  publishedAt: string
  // 请求者维度启用位（#1058 开关初始态）：市场「发布」≠ 本人「启用」
  enabled: boolean
}

export interface SkillPackageDetail extends SkillMarketItem {
  files: readonly { path: string; mime: string; size: number }[]
}

export async function listSkills(p: { category?: string; q?: string } = {}): Promise<SkillMarketItem[]> {
  const query = new URLSearchParams()
  if (p.category) query.set('category', p.category)
  if (p.q) query.set('q', p.q)
  const qs = query.toString()
  return apiJson<SkillMarketItem[]>(`/api/v1/skills${qs ? `?${qs}` : ''}`)
}

export async function getSkillDetail(id: string): Promise<SkillPackageDetail> {
  return apiJson<SkillPackageDetail>(`/api/v1/skills/${encodeURIComponent(id)}`)
}

// 上传（multipart field 'file'——client.ts 对 FormData 不设 Content-Type，浏览器自带 boundary）。
// 拒收（非 0 码，80002 为主）不抛：结构化结果直返，reasons[]（A 票管线逐条原因）由视图逐条
// 展示（#1058 验收面）；网络/HTTP 层错误照常抛 ApiError。
export interface SkillUploadOk { ok: true; id: string; name: string; category: string }
export interface SkillUploadRejected { ok: false; code: number; message: string; reasons: string[] }
export type SkillUploadResult = SkillUploadOk | SkillUploadRejected

export async function uploadSkill(file: File): Promise<SkillUploadResult> {
  const form = new FormData()
  form.append('file', file, file.name || 'skill.zip')
  const resp = await apiFetch('/api/v1/skills', { method: 'POST', body: form })
  if (!resp.ok) throw new ApiError(resp.status, `上传失败 (${resp.status})`)
  const env = parseEnvelope(await parseEnvelopeBody(resp))
  if (env && env.code !== 0) {
    const data = env.data as { reasons?: unknown } | null
    const reasons = Array.isArray(data?.reasons) ? data.reasons.filter((r): r is string => typeof r === 'string') : []
    return { ok: false, code: env.code, message: env.message || 'Skill 包校验未通过', reasons }
  }
  const data = (env ? env.data : null) as { id?: unknown; name?: unknown; category?: unknown } | null
  if (!data || typeof data.id !== 'string' || typeof data.name !== 'string' || typeof data.category !== 'string') {
    throw new ApiError(resp.status, '上传响应形状异常')
  }
  return { ok: true, id: data.id, name: data.name, category: data.category }
}

// 下载（认证字节通道，readAttachmentBlob 同款防误判：JSON 且无 Content-Disposition 才是错误
// 信封；二进制成功响应不消费 body 直接 blob）。
export async function readSkillBlob(id: string, signal?: AbortSignal): Promise<Blob> {
  const response = await apiFetch(`/api/v1/skills/${encodeURIComponent(id)}/download`, { signal, timeoutMs: 300_000 })
  if (response.headers.get('Content-Type')?.includes('application/json') && !response.headers.get('Content-Disposition')) {
    const envelope = await parseEnvelopeBody(response) as { code?: number; message?: string } | null
    throw new ApiError(response.status, envelope?.message || 'Skill 包不可用', envelope?.code)
  }
  if (!response.ok) throw new ApiError(response.status, 'Skill 包下载失败')
  return response.blob()
}

// 删除（作者本人或 admin；B 票 80041 同码防探测——他人/不存在同错误面）。
export async function deleteSkill(id: string): Promise<void> {
  await apiJson<null>(`/api/v1/skills/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// 启用位（per-user 幂等 upsert；D4：启用 → 下一 run 注入目录行 + read_skill）。
export async function setSkillEnablement(id: string, enabled: boolean): Promise<{ skillId: string; enabled: boolean }> {
  return apiJson<{ skillId: string; enabled: boolean }>(`/api/v1/skills/${encodeURIComponent(id)}/enablement`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}
