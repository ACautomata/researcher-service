// ADR 0009 / #397 / #399：双列表（messages + approvals）渲染期合并为单一时间线的纯函数。
// 与 eventTranslate.ts 并列的纯翻译层——messages 数组的 mutation 零改动（claimRun/finalizeLast/
// loadHistory/send 等状态机不碰），审批卡按全局单调到达序号 seq 插入。
// 流式占位强制沉底是渲染期不变式：状态机「数组最后一条 = 流式占位」假设恒成立。
import type { ApprovalItem, Msg } from '@/stores/chat'

export type TimelineEntry = Msg | ApprovalItem

// 时间线条目判别守卫（随类型同置：ChatStream 窄化渲染用；鸭子判别避免互相结构兼容误判）
export function isApprovalEntry(e: TimelineEntry): e is ApprovalItem {
  return 'status' in e && 'id' in e
}

// 锚定规则（ADR 0009 定案）：
// - 有流式占位（streaming=true 的最后一条 assistant）→ 插占位之前（占位恒为末条，视觉即「插占位之后」）
// - 无流式占位且末尾是已落定 assistant 气泡 → 插该气泡之前
// - 无 assistant 消息 → 插末尾
// 多卡间按 seq 到达先后（统一在插入点排好，卡与卡不乱序）。
function insertionIndex(messages: Msg[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue
    if (messages[i].streaming) return i // 流式占位强制沉底：卡插占位之前
    return i // 已落定 assistant 气泡：卡插气泡之前
  }
  return messages.length // 无 assistant 消息：插末尾
}

export function mergeTimeline(messages: Msg[], approvals: ApprovalItem[]): TimelineEntry[] {
  if (approvals.length === 0) return messages

  // 纯函数：排序用副本，不改动调用方数组
  const sorted = [...approvals].sort((a, b) => a.seq - b.seq)
  const insertIdx = insertionIndex(messages)
  const out: TimelineEntry[] = []
  messages.forEach((m, i) => {
    if (i === insertIdx) out.push(...sorted)
    out.push(m)
  })
  if (insertIdx === messages.length) out.push(...sorted)
  return out
}
