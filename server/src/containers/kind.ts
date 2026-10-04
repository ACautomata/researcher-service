// 容器 kind 三值分派（#784 · #747 B/E 节）——create/health/delete 三操作 × legacy|wiki|sandbox
// 三支路的路由单一来源。纯函数零 IO。
//
// 消费点（现状，如实）：
//   - containerKind：DockerWikiContainerRuntime（防御性识别——派生名上的容器 kind ≠ wiki 视为
//     非本编排资产，getWiki/remove 一律不触碰，沙箱 toInfoCommon 防御同构）；
//   - dispatchByKind：三支路操作路由 seam（单测锁定 create/health/delete 路径正确）。wiki/sandbox
//     的 create/health 面当前由各自消费方直调支路（wiki REST ensure / runner run 前 ensure——
//     消费方在调用点已知自己的 kind，分派表收口于删除面）；**legacy 支路（T0 删除路径的识别
//     标记）与跨 kind 清理编排落地时经此分派**（#747 B 节：legacy 值仅为 T0 删除路径识别标记，
//     切换日后不再出现）。
//
// 三支路真身：legacy = fleet FleetCommand/FleetReadModel，wiki = wikiContainers/lifecycle，
// sandbox = sandboxes/lifecycle。

import { KIND_SANDBOX, KIND_WIKI, LABEL_KIND_KEY } from './constants'

// kind 三值（#776 立沙箱支路、#784 收口 wiki 支路 + 分派面）
export type ContainerKind = 'legacy' | 'wiki' | 'sandbox'

// 按 docker inspect 的 Config.Labels 识别 kind。识别规则（#747 B 节）：
//   - researcher.kind=wiki|sandbox → 对应新世界支路；
//   - 其余一律 legacy——fleet 容器（app=openclaw-fleet）不带 kind 标签、显式 kind=legacy 与
//     外来无标签容器同归 legacy 支路（保守面：分派永不因标签缺失而抛错，T0 清理路径靠它
//     把「认不出的容器」当 legacy fleet 走完整删除编排）。
export function containerKind(labels: Record<string, string> | null | undefined): ContainerKind {
  const v = labels?.[LABEL_KIND_KEY]
  if (v === KIND_WIKI) return 'wiki'
  if (v === KIND_SANDBOX) return 'sandbox'
  return 'legacy'
}

// 三支路同形的操作路由表：T = 该支路的操作实现（ensure/health/remove 等任意形状）。
// 键语义支路自持（wiki/sandbox 按 ownerId/sessionId，legacy 按实例名），分派层不解释。
export interface KindRoutes<T> {
  readonly wiki: T
  readonly sandbox: T
  readonly legacy: T
}

// 按 kind 取支路。dispatchByKind(containerKind(labels), routes) 即「标签 → 处理路径」全链。
export function dispatchByKind<T>(kind: ContainerKind, routes: KindRoutes<T>): T {
  return routes[kind]
}
