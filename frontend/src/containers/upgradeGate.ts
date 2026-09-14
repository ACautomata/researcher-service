// #702 前端惰性升级的纯决策层：把「能否连 chat / 是否该触发 upgrade / 是否该继续 poll」三问收敛成
// 单一纯函数（`upgradeDecision`），宿主 ChatView 只接线、不散落 if（对齐 #667 panels/triState.ts 的
// 纯函数→composable→哑组件三层）。
//
// 语义对齐 #699/#701 服务端（本文件不复制服务端规则，只做前端前置判定 + 文案单一来源）：
//   - status=upgrading   六步升级在飞——不再触发（服务端幂等）、轮询等终态、期间不建网关连接；
//   - status=upgrade_failed 连续失败终态——仅可删除重建，恒不再自动触发、不轮询、不重连；
//   - needs_upgrade      读侧记账判定（行镜像 ≠ 目标镜像）——打开时惰性触发升级；
//   - 其余状态           ∉ {running, stopped} 时服务端 upgradeReserve 返 20043 busy，前端前置拦下，
//                        不打无谓请求（「不产生重复 upgrade 请求风暴」）。

export interface UpgradeFacts {
  readonly status?: string | undefined
  readonly needsUpgrade?: boolean | undefined
}

// 打开容器后的唯一去向。
export type UpgradeDecision =
  | { readonly kind: 'connect' } // 可直接建连对话
  | { readonly kind: 'trigger' } // 需升级：先触发再轮询
  | { readonly kind: 'poll' } // 升级在飞：轮询直到终态
  | { readonly kind: 'terminal' } // 升级失败终态：只透出，不触发不轮询
  | { readonly kind: 'blocked' } // 状态不允许升级：如实透出，等用户重试

export type UpgradeBadgeTone = 'warning' | 'primary' | 'danger'

export interface UpgradeBadge {
  readonly label: string
  readonly tone: UpgradeBadgeTone
}

// 文案单一来源（列表徽标 / 横幅 / 终态卡 / 错误提示共用，防多处手写漂移）。
export const UPGRADE_BANNER_TEXT = '容器升级中'
export const UPGRADE_FAILED_TITLE = '容器升级失败，仅可删除重建'
export const UPGRADE_FAILED_DETAIL =
  '重建会丢失该容器的全部数据；升级前的数据已备份到独立备份卷，可从备份手工救回。'
export const UPGRADE_RETRY_HINT = '升级未完成，可重试'

// 服务端 upgradeReserve 的受理前提（其余 status 一律 20043 busy）——前端据此前置拦。
const UPGRADABLE = new Set(['running', 'stopped'])

// 三问的唯一判据（其余导出谓词全由此派生，保证决策不劈叉）。
export function upgradeDecision(facts: UpgradeFacts | undefined | null): UpgradeDecision {
  const status = facts?.status
  // 终态与在飞优先于 needs_upgrade：upgrading 期间读侧 needs_upgrade 仍可能为真，不能据此重复触发；
  // upgrade_failed 更须恒不触发（#701 语义）。
  if (status === 'upgrade_failed') return { kind: 'terminal' }
  if (status === 'upgrading') return { kind: 'poll' }
  if (facts?.needsUpgrade) {
    return status !== undefined && UPGRADABLE.has(status) ? { kind: 'trigger' } : { kind: 'blocked' }
  }
  return { kind: 'connect' }
}

export function canConnectChat(facts: UpgradeFacts | undefined | null): boolean {
  return upgradeDecision(facts).kind === 'connect'
}

export function shouldTriggerUpgrade(facts: UpgradeFacts | undefined | null): boolean {
  return upgradeDecision(facts).kind === 'trigger'
}

export function shouldContinuePolling(facts: UpgradeFacts | undefined | null): boolean {
  return upgradeDecision(facts).kind === 'poll'
}

// 列表徽标：三态文案 + 视觉状态三者互不相同（需升级=warning 黄 / 升级中=primary 蓝 /
// 升级失败=danger 红）；无需升级 → null（不渲染徽标）。
export function upgradeBadge(facts: UpgradeFacts | undefined | null): UpgradeBadge | null {
  const status = facts?.status
  if (status === 'upgrade_failed') return { label: '升级失败', tone: 'danger' }
  if (status === 'upgrading') return { label: '升级中', tone: 'primary' }
  if (facts?.needsUpgrade) return { label: '需升级', tone: 'warning' }
  return null
}
