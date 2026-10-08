// wiki API —— 每用户（owner 级，#856）wiki tree/page CRUD/graph/categories/claims/update
// （spec §6 / issue #45）。owner 直取认证身份——调用方不传容器名（wiki 域与容器行脱钩）。
// path 为相对树根的 posix 相对路径，经 encodeURIComponent 编码进 query。删除幂等：
// 30040（他人刚删）不报错——错误经 apiJson 对 code!==0 抛，调用方据 toast 提示失败。
import { apiJson } from '@/api/client'

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
  okf?: { status?: string; staleAfter?: string; generatedAt?: string }
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

const BASE = '/api/v1/wiki'

export function getTree(): Promise<WikiTreeDTO> {
  return apiJson<WikiTreeDTO>(`${BASE}/tree`)
}

export function readPage(path: string): Promise<WikiPageContentDTO> {
  return apiJson<WikiPageContentDTO>(`${BASE}/page?path=${encodeURIComponent(path)}`)
}

export function updatePage(path: string, content: string): Promise<void> {
  return apiJson<void>(`${BASE}/page`, {
    method: 'PUT',
    body: JSON.stringify({ path, content }),
  })
}

export function createPage(path: string, content: string): Promise<void> {
  return apiJson<void>(`${BASE}/page`, {
    method: 'POST',
    body: JSON.stringify({ path, content }),
  })
}

export async function deletePage(path: string): Promise<void> {
  // 经 apiJson：后端错误恒 HTTP 200 + 信封 code（旧 apiFetch+resp.ok 把它当成功，
  // PR #370 第四轮 #9 P0）。apiJson 对 code!==0 抛，调用方据 toast 提示失败。
  await apiJson<void>(`${BASE}/page?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  })
}

export function getGraph(): Promise<WikiGraphDTO> {
  return apiJson<WikiGraphDTO>(`${BASE}/graph`)
}

export function getCategories(): Promise<CategoriesDTO> {
  return apiJson<CategoriesDTO>(`${BASE}/categories`)
}

export interface WikiClaimsDTO {
  schemaVersion: number | null
  pageVersion: string | null
  drift: 'fresh' | 'drifted' | null
  claims: { id: string; statement: string; evidence: { resource: string; version?: string }[] }[]
}

export function getClaims(path: string): Promise<WikiClaimsDTO> {
  return apiJson(`${BASE}/claims?path=${encodeURIComponent(path)}`)
}

export function startWikiUpdate(): Promise<{ runId: string }> {
  return apiJson(`${BASE}/update`, { method: 'POST' })
}
