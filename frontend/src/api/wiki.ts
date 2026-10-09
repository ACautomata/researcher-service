// wiki API —— 每用户（owner 级，#856）wiki tree/page 读/graph/claims/update
// （spec §6 / issue #45）。owner 直取认证身份——调用方不传容器名（wiki 域与容器行脱钩）。
// path 为相对树根的 posix 相对路径，经 encodeURIComponent 编码进 query。
// 页写面（create/update/delete）已随 server 侧写端点退役清零——本 client 只留读面 + update run 启动。
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

const BASE = '/api/v1/wiki'

export function getTree(): Promise<WikiTreeDTO> {
  return apiJson<WikiTreeDTO>(`${BASE}/tree`)
}

export function readPage(path: string): Promise<WikiPageContentDTO> {
  return apiJson<WikiPageContentDTO>(`${BASE}/page?path=${encodeURIComponent(path)}`)
}

export function getGraph(): Promise<WikiGraphDTO> {
  return apiJson<WikiGraphDTO>(`${BASE}/graph`)
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
