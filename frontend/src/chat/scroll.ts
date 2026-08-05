// ADR 0009 / #397 / #400：对话窗口自动滚动（范式 B 上滚让位 + rAF 节流）。
// 纯函数判定层——宿主在 ChatStream.vue 内部，滚动容器即根元素 .stream（overflow-y:auto）。
// 范式 B：仅当用户停留在底部（距底 < FOLLOW_THRESHOLD）时自动跟随；上滚离开底部后不抢滚动条；
// 回到底部后恢复跟随。展开审批详情（detailOpen）不联动滚动（标准聊天 UX）。
// rAF 节流在宿主实现（一帧内多次 delta 合并滚一次），本模块只做几何判定，可单测。

// 距底阈值（px）：滚动位置距底小于该值视为「停留在底部」。8px 兼顾误判（少量残留视口）与灵敏。
export const FOLLOW_THRESHOLD = 8

// 范式 B 判定：给定滚动几何，当前是否应自动跟随到底。
// 距底 = scrollHeight - clientHeight - scrollTop；距底 < 阈值（含等于）→ 跟随。
export function shouldFollowBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  const distanceToBottom = scrollHeight - clientHeight - scrollTop
  return distanceToBottom <= FOLLOW_THRESHOLD
}
