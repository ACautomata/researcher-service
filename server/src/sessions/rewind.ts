// rewind / fork 共用的历史判定纯逻辑（#781 · #747 story 16/18 · #770 软删存档）。
// 三个判定：锚点解析（消息行 → rewind 锚点 checkpoint）、被放弃 checkpoint 集（未归档全体 −
// 锚点链）、可见行挂靠（锚点链上每条消息行的归属——rewind 归档与 fork 截断复制共用同一判据）。
// 不触库、不发布事件（S3 接缝纪律对齐 TurnReducer）。
//
// 挂靠规则（rewind 后投影 ≡ 锚点时刻 = 「锚点之后写入的轮统统不可见」）：
//   - assistant 行：anchorCheckpointId 非空 = 权威归属（∈ 锚点链才可见）；为 null（aborted/
//     failed 轮无终态 state）挂靠后继最近 assistant 的可见性——分支内的失败轮随其后继轮保留
//     （后继 ∈ 链），锚点之后的失败尾部（无后继）与随后被放弃轮的失败一并不可见（R 评审：
//     前驱挂靠会让锚点后的失败尾部在 rewind 后恒可见，违反「与锚点时刻一致」）。
//   - user/system 行：归属 = 它触发的轮 —— 后继最近 assistant 行的可见性；无后继（活跃头部
//     新输入 / 崩溃残留）→ 可见（无后继不可判定归属，保守不归档——崩溃重放面另有 #779 收尾）。
// 锚点解析（story 16「rewind 到任一历史消息锚点重开」）：assistant 行 → 自身锚点；user 行 →
// 前驱最近带锚 assistant 锚点（改 prompt 重来 = 该消息入图之前的 state）；会话头部/无锚可达
// → null（调用方 90002）。输入 rows 恒为未归档行（调用方过滤 archivedAt——#770 无恢复入口：
// 归档行不可再作锚点/切点）。

export interface HistoryRowLite {
  readonly id: string
  readonly turn: number
  readonly role: string
  readonly anchorCheckpointId: string | null
  readonly createdAt: Date
}

function byTurnCreatedAt(a: HistoryRowLite, b: HistoryRowLite): number {
  return a.turn - b.turn || a.createdAt.getTime() - b.createdAt.getTime()
}

// 解析 rewind 锚点 checkpoint id；不可作锚点（system 行 / 失败轮无锚 / 会话头部 / id 不存在）
// → null。
export function resolveRewindAnchor(rows: readonly HistoryRowLite[], messageId: string): string | null {
  const sorted = [...rows].sort(byTurnCreatedAt)
  const idx = sorted.findIndex((r) => r.id === messageId)
  if (idx < 0) return null
  const target = sorted[idx]!
  if (target.role === 'assistant' && target.anchorCheckpointId !== null) return target.anchorCheckpointId
  for (let i = idx - 1; i >= 0; i--) {
    const r = sorted[i]!
    if (r.role === 'assistant' && r.anchorCheckpointId !== null) return r.anchorCheckpointId
  }
  return null
}

// 被放弃 checkpoint 集 = 未归档 checkpoint 全体 − 锚点祖先链（含锚点）。全量差集而非旧 head
// 链行走（R 评审）：不经旧 head 的死亡分叉（失败轮超步残留、跨分支脏数据）一并入集，也不依赖
// 「最新 checkpointId 字典序」猜头（UUIDv6 下近似时序，失败轮残留会污染）。
export function abandonedCheckpointIds(
  allCheckpointIds: readonly string[],
  anchorChain: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>()
  for (const id of allCheckpointIds) if (!anchorChain.has(id)) out.add(id)
  return out
}

// 锚点祖先链（含锚点自身；parentOf 环/超深 guard 同上）。rewind 归档与 fork 截断复制的
// 共用判定集。
export function anchorChainOf(parentOf: (id: string) => string | null, anchor: string): Set<string> {
  return collect(parentOf, anchor)
}

function collect(parentOf: (id: string) => string | null, start: string): Set<string> {
  const seen = new Set<string>()
  let cur: string | null = start
  while (cur !== null && !seen.has(cur) && seen.size < 10_000) {
    seen.add(cur)
    cur = parentOf(cur)
  }
  return seen
}

// 锚点链（含锚点）上的可见消息行 id 集。rows 无需预排序（内部稳定排序），恒输入未归档行。
// 单遍右→左：带锚 assistant 按链归属解出后作为后继基准；null 锚 assistant 与 user/system
// 行都挂靠「后继最近 assistant 的已解可见性」（null 锚链式前推）；无后继时 null 锚 assistant
// 不可见（锚点之后的失败尾部）、user/system 可见（活跃头部新输入）。
export function visibleRowIds(rows: readonly HistoryRowLite[], anchorChain: ReadonlySet<string>): Set<string> {
  const sorted = [...rows].sort(byTurnCreatedAt)
  const n = sorted.length
  const visible = new Array<boolean>(n)

  let nextAssistantVisible: boolean | undefined // undefined = 后方尚无 assistant 行
  for (let i = n - 1; i >= 0; i--) {
    const r = sorted[i]!
    if (r.role === 'assistant') {
      visible[i] =
        r.anchorCheckpointId !== null ? anchorChain.has(r.anchorCheckpointId) : (nextAssistantVisible ?? false)
      nextAssistantVisible = visible[i]
    } else {
      visible[i] = nextAssistantVisible ?? true
    }
  }

  const out = new Set<string>()
  for (let i = 0; i < n; i++) if (visible[i]) out.add(sorted[i]!.id)
  return out
}
