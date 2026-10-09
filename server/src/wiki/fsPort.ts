// WikiFileSystem Port（#335 · 平移 backend/integration/openclaw/ports.py 路径2）。
// 业务层只依赖本接口；生产适配器 = dockerFs.ts（DockerWikiFileSystem，#784），测试注入 fake（接缝）。
// 读面方法抛 wiki 域异常（errors.ts）：越权/穿越/managed → WikiInvalidPath、不存在 → WikiPageNotFound。
// 写面成员（writePage/createPage/deletePage）已随 #758 Q3 写面整域退役物理删除——零生产调用
//（agent 写路径 = runner/wikigen mirror pushBack + FilesystemBackend，不经 WikiService）。

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
  // claims 旁车原文（#789 story 42 数据面）：页路径入参，适配器映射 .claims 镜像同名 .json；
  // 旁车缺失/不可解码 → null（不抛——「无旁车」对消费方同义）。
  readClaimsFile(relPath: string): Promise<string | null>
}
