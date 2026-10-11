// token 预算 → 字符截断共享 util（#853 §7.2 交接项：自 runner/approval/judge.ts 提取）。
// 两消费者 = 审批 judge（输入构造 ≤8k tokens）与 research 插件 contextPack（预算裁剪，
// 853 §4.3「换算口径复用 JUDGE_CHARS_PER_TOKEN=2」）——提取时机 = 第二消费者落地前。
//
// 常量名保持 JUDGE_CHARS_PER_TOKEN（853 §7.1/§4.3 点名复用该口径名；语义 = token→字符
// 换算因子单一来源，CJK 保守取 2 chars/token：中文 ≈1.5-2 chars/token，取 2 保证不超预算
// 上限）。

/** token → 字符换算因子（judge 输入截断面唯一换算处）。 */
export const JUDGE_CHARS_PER_TOKEN = 2

// token 预算 → 字符截断（换算因子单一来源 JUDGE_CHARS_PER_TOKEN）。
export function truncateToTokenBudget(text: string, tokens: number): string {
  const max = Math.max(0, tokens) * JUDGE_CHARS_PER_TOKEN
  if (text.length <= max) return text
  return text.slice(0, max)
}
