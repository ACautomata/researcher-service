// ADR 0009 / #397 / #399：双列表（messages + approvals）渲染期合并为单一时间线的纯函数。
// 与 eventTranslate.ts 并列的纯翻译层——messages 数组的 mutation 零改动（claimRun/finalizeLast/
// loadHistory/send 等状态机不碰），审批卡按全局单调到达序号 seq 插入。
// 流式占位强制沉底是渲染期不变式：状态机「数组最后一条 = 流式占位」假设恒成立。
// #405-T2（#407）：main 会话还没有任何 assistant 消息且有待展示审批卡时，时间线尾部合成
// SyntheticAnchor 虚拟气泡承载审批卡（渲染为淡色虚线边框、无文本、高度贴近卡片的虚拟气泡）；
// 卡全 resolved 后虚拟气泡仍留存（时间线不跳动）。messages 数组零改动（#340 消息/审批分离不变量）。
import type { ApprovalItem, Msg } from '@/stores/chat'

export interface SyntheticAnchor {
  // 虚拟气泡条目（#405-T2）：main 无 assistant 消息时承载审批卡的合成落点。
  // 判别守卫 isSyntheticAnchor（鸭子判别，避免与 Msg/ApprovalItem 结构兼容误判）；
  // 有意不含 content 字段——有字段即承诺渲染内容，虚拟气泡无文本（规格定案）。
  anchor: true
}

export type TimelineEntry = Msg | ApprovalItem | SyntheticAnchor

// 时间线条目判别守卫（随类型同置：ChatStream 窄化渲染用；鸭子判别避免互相结构兼容误判）
export function isApprovalEntry(e: TimelineEntry): e is ApprovalItem {
  return 'status' in e && 'id' in e
}

// 虚拟气泡判别守卫（#405-T2）：anchor 真值标记 + 仅此一字段
export function isSyntheticAnchor(e: TimelineEntry): e is SyntheticAnchor {
  return typeof e === 'object' && e !== null && 'anchor' in e && e.anchor === true
}

// 锚定规则（ADR 0009 定案）：
// - 有流式占位（streaming=true 的最后一条 assistant）→ 插占位之前（占位恒为末条，视觉即「插占位之后」）
// - 无流式占位且末尾是已落定 assistant 气泡 → 插该气泡之前
// - 无 assistant 消息 → 插末尾（#405-T2：anchorState=true 时合成 SyntheticAnchor 承载）
// 多卡间按 seq 到达先后（统一在插入点排好，卡与卡不乱序）。
function insertionIndex(messages: Msg[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue
    if (messages[i].streaming) return i // 流式占位强制沉底：卡插占位之前
    return i // 已落定 assistant 气泡：卡插气泡之前
  }
  return messages.length // 无 assistant 消息：插末尾
}

// #405-T2：anchorState = 是否有待展示审批卡（ChatView 由 visibleApprovals 计算传入）。
// 有 assistant 消息（含流式占位）→ 不需要合成落点（锚定三分支覆盖）；anchorState 须与待展示
// 卡数量同真才合成——anchorState=true 但 approvals 为空时不产出虚拟气泡（无卡可承载）。
// 合成锚不参与 seq 排序（位置恒定在尾部、卡承载其后）；agentId 不参与锚点计算（#407 验收）。
// 在插入点输出：synthetic 时先推虚拟气泡（锚在卡前——「虚拟助手气泡承载审批卡」语义）。
// 卡全 resolved 后锚仍留存（anchorState 不随卡 resolved 变化，由 visibleApprovals 数量驱动）。
function pushAt(out: TimelineEntry[], synthetic: boolean, sorted: ApprovalItem[]): void {
  if (synthetic) out.push({ anchor: true })
  out.push(...sorted)
}

export function mergeTimeline(
  messages: Msg[],
  approvals: ApprovalItem[],
  anchorState = false,
): TimelineEntry[] {
  if (approvals.length === 0) return messages

  // 纯函数：排序用副本，不改动调用方数组
  const sorted = [...approvals].sort((a, b) => a.seq - b.seq)
  const insertIdx = insertionIndex(messages)
  const synthetic = insertIdx === messages.length && anchorState
  const out: TimelineEntry[] = []
  messages.forEach((m, i) => {
    if (i === insertIdx) pushAt(out, synthetic, sorted)
    out.push(m)
  })
  if (insertIdx === messages.length) pushAt(out, synthetic, sorted)
  return out
}
