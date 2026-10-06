// WikiFileSystem Port（#335 · 平移 backend/integration/openclaw/ports.py 路径2）。
// 业务层只依赖本接口；Node 适配器在 nodeFs.ts（node:fs/promises），测试注入 fake（接缝）。
// 所有方法抛 wiki 域异常（errors.ts）：越权/穿越 → WikiInvalidPath、不存在 → WikiPageNotFound、
// 已存在（create）→ WikiPageExists。

import type { OkfBadge, ParsedClaimsSidecar } from './logic'

// claims 只读面返回形状（#789 story 42 数据面）：旁车缺失/畸形 → schemaVersion/pageVersion
// 为 null、drift 为 null、claims 空（前端「无证据面板」语义，不报错）。
export interface WikiClaims extends ParsedClaimsSidecar {
  drift: 'fresh' | 'drifted' | null
}

export interface WikiTreePage {
  path: string
  title: string
}

export interface WikiTreeGroup {
  kind: string
  name: string
  pages: WikiTreePage[]
}

export interface WikiTree {
  groups: WikiTreeGroup[]
}

export interface WikiPage {
  path: string
  title: string
  content: string
  /** OKF 徽章数据面（#789 story 41）：非 OKF 页缺省（不进 JSON） */
  okf?: OkfBadge
}

// categories 聚合入口：递归扫全库 .md（含顶层散落页），带全文 content 与 title。
// 与 build_tree 共享 root 防护与遍历防护；title 语义对齐 read_page（frontmatter→H1→stem）。
export interface WikiCategoryPage {
  path: string
  title: string
  content: string
}

export interface WikiCategoryItem {
  path: string
  title: string
  category: string
  excerpt: string
}

export interface WikiGraphNode {
  id: string
  title: string
  ghost?: boolean
}

export interface WikiGraphEdge {
  from: string
  to: string
}

export interface WikiGraph {
  nodes: WikiGraphNode[]
  edges: WikiGraphEdge[]
}

export interface WikiFileSystem {
  buildTree(): Promise<WikiTree>
  readPage(relPath: string): Promise<WikiPage>
  listCategoryPages(): Promise<WikiCategoryPage[]>
  writePage(relPath: string, content: string): Promise<{ path: string }>
  createPage(relPath: string, content: string): Promise<{ path: string }>
  deletePage(relPath: string): Promise<void>
  // claims 旁车原文（#789 story 42 数据面）：页路径入参，适配器映射 .claims 镜像同名 .json；
  // 旁车缺失/不可解码 → null（不抛——「无旁车」对消费方同义）。
  readClaimsFile(relPath: string): Promise<string | null>
}
