// 容器 kind 标签识别（#784 立 · #747 B/E 节；#858 三值收敛 wiki|sandbox）。纯函数零 IO。
//
// 消费点（现状，如实）：DockerWikiContainerRuntime 防御性识别——派生名上的容器 kind ≠ wiki
// 视为非本编排资产，getWiki/remove 一律不触碰（沙箱 dockerRuntime 同构防御按标签字面直判）。
// 旧 dispatchByKind 三支路路由 seam 随 fleet（legacy 支路唯一落点）退役删除——wiki/sandbox 的
// create/health 面本就由各自消费方直调支路（wiki REST ensure / runner run 前 ensure），分派表
// 从未有第二消费方。
//
// 两支路真身：wiki = wikiContainers/lifecycle，sandbox = sandboxes/lifecycle。

import { KIND_SANDBOX, KIND_WIKI, LABEL_KIND_KEY } from './constants'

// kind 二值（#776 立沙箱支路、#784 收口 wiki 支路 + 分派面；#858 legacy 值随 fleet 退役）
export type ContainerKind = 'wiki' | 'sandbox'

// 按 docker inspect 的 Config.Labels 识别 kind。识别规则（#858 收敛后）：
//   - researcher.kind=wiki|sandbox → 对应 kind；
//   - 其余（无标签 / 外来容器 / fleet 存量容器）→ null——非本编排资产，防御性消费方不触碰。
export function containerKind(labels: Record<string, string> | null | undefined): ContainerKind | null {
  const v = labels?.[LABEL_KIND_KEY]
  if (v === KIND_WIKI) return 'wiki'
  if (v === KIND_SANDBOX) return 'sandbox'
  return null
}
