// wiki API —— 每容器 wiki/main tree/page CRUD/graph（spec §6 / issue #45）。
// 直读/直写宿主 instances/<name>/home/wiki/main；path 为相对 wiki/main 的 posix 相对路径，
// 经 encodeURIComponent 编码进 query。删除幂等：404（他人刚删）不报错。
import { apiFetch, apiJson, ApiError } from '@/api/client'

export interface WikiPageDTO {
  path: string
  title: string
}

export interface WikiTreeGroupDTO {
  kind: string
  name: string
  pages: WikiPageDTO[]
}

export interface WikiTreeDTO {
  groups: WikiTreeGroupDTO[]
}

export interface WikiPageContentDTO {
  path: string
  title: string
  content: string
}

export interface WikiGraphNodeDTO {
  id: string
  title: string
  ghost?: boolean
}

export interface WikiGraphEdgeDTO {
  from: string
  to: string
}

export interface WikiGraphDTO {
  nodes: WikiGraphNodeDTO[]
  edges: WikiGraphEdgeDTO[]
}

// categories 聚合条目（issue #84 / #85）：path/title/category/excerpt。
export interface CategoryItemDTO {
  path: string
  title: string
  category: string
  excerpt: string
}

// categories 聚合响应：键为动态 category 值（开放词表），值为该组带标记页列表。
export type CategoriesDTO = Record<string, CategoryItemDTO[]>

function base(name: string): string {
  return `/api/v1/containers/${encodeURIComponent(name)}/wiki`
}

export function getTree(name: string): Promise<WikiTreeDTO> {
  return apiJson<WikiTreeDTO>(`${base(name)}/tree`)
}

export function readPage(name: string, path: string): Promise<WikiPageContentDTO> {
  return apiJson<WikiPageContentDTO>(`${base(name)}/page?path=${encodeURIComponent(path)}`)
}

export function updatePage(name: string, path: string, content: string): Promise<void> {
  return apiJson<void>(`${base(name)}/page`, {
    method: 'PUT',
    body: JSON.stringify({ path, content }),
  })
}

export function createPage(name: string, path: string, content: string): Promise<void> {
  return apiJson<void>(`${base(name)}/page`, {
    method: 'POST',
    body: JSON.stringify({ path, content }),
  })
}

export async function deletePage(name: string, path: string): Promise<void> {
  // 删除幂等：404（他人刚删）不报错
  const resp = await apiFetch(`${base(name)}/page?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  })
  if (!resp.ok && resp.status !== 404) {
    throw new ApiError(resp.status, '删除失败')
  }
}

export function getGraph(name: string): Promise<WikiGraphDTO> {
  return apiJson<WikiGraphDTO>(`${base(name)}/graph`)
}

export function getCategories(name: string): Promise<CategoriesDTO> {
  return apiJson<CategoriesDTO>(`${base(name)}/categories`)
}
