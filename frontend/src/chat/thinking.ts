// T08 思考链剥离（issue #44 / spec §8.3 / r26 §4）：protocol v4 无独立 thinking 帧，思考内容以
// `<thinking>...</thinking>` XML 标签**内联在 chat text 增量里**（paired 实测确认）→ 内容层解析剥离。
// 后端 text 帧原样透传（不动协议/TDD 契约），前端对每条消息的原始累积文本扫描拆分：thinking 段进折叠卡
// 独立渲染（升级 spec §8.3 (a)），其余进正文。流式中未闭合的 thinking 暂入 thinking（卡片随流式生长）；
// 始终无闭合标签的原始文本保底留正文（不丢）。
//
// 设计为纯函数：replace 快照直接对快照重解析；delta 追加先拼接原始串再整体重解析——无需跨帧状态。

export interface ThinkingParts {
  text: string // 剥离 thinking 后的正文（流式中的部分 thinking 标签残片也一并隐藏）
  thinking: string // 已剥离出的思考内容（可能因流式未闭合而是片段）
  inThinking: boolean // 当前是否处于未闭合的 <thinking> 内（用于卡片「思考中」态）
}

const OPEN = '<thinking>'
const CLOSE = '</thinking>'

// 把原始累积文本拆成 正文 / 思考 两段。大小写敏感（网关按小写 `<thinking>` 下发，r26 §4 实测）。
// 扫描思路：线性找 OPEN/CLOSE 配对；OPEN 前、CLOSE 后归正文，OPEN..CLOSE 间归 thinking。
// 末尾若悬着半个 `<thi…` 标签残片（流式截断），归入正文但自残片起点截断——避免逐字泄露尖括号标签。
// finalize=true 用于终态重解析（issue #198 问题 5）：终态无「下帧补齐」可言，
// 未补齐的 `<` 残片按普通文本放回正文，不再截断隐藏。既有流式行为（默认 false）不变。
export function splitThinking(raw: string, finalize = false): ThinkingParts {
  let text = ''
  let thinking = ''
  let inThinking = false
  let i = 0
  const n = raw.length
  while (i < n) {
    if (!inThinking) {
      const open = raw.indexOf(OPEN, i)
      // 末尾半截 `<thi…` 残片（OPEN 的前缀）属流式截断，不入正文（下帧补齐后再判）；
      // 终态（finalize）无下帧，残片按普通文本放回正文
      const openStart = open === -1 ? (finalize ? n : partialTagStart(raw, i)) : open
      text += raw.slice(i, openStart)
      if (open === -1) {
        i = n // 无完整 OPEN：到末尾（残片已截断）
      } else {
        inThinking = true
        i = open + OPEN.length
      }
    } else {
      const close = raw.indexOf(CLOSE, i)
      if (close === -1) {
        // thinking 未闭合（流式中）：其余全入 thinking
        thinking += raw.slice(i, n)
        i = n
      } else {
        thinking += raw.slice(i, close)
        inThinking = false
        i = close + CLOSE.length
      }
    }
  }
  return { text, thinking, inThinking }
}

// raw 自 from 起、末尾为 OPEN 标签前缀（`<`、`<t`、…、`<thinking`）的起始下标；无残片则返回 raw.length。
// 用于流式中把「可能是 <thinking> 开头但没到齐」的半截标签先从正文藏起来。
function partialTagStart(raw: string, from: number): number {
  for (let k = raw.length - 1; k >= from; k--) {
    if (raw[k] !== '<') continue
    const tail = raw.slice(k)
    if (OPEN.startsWith(tail)) return k
  }
  return raw.length
}
