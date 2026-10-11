// LLM 文本响应的 JSON 对象容错提取（judge parseJudgeOutput 与插件 parseStructuredOutput
// 的共享实现——两处逐字重复的剥围栏/大括号定位/parse 六行收拢，#914 review L2）。

// 从 LLM 原始文本提取顶层 JSON 对象：``` 围栏剥除 → 首个 `{` 到末个 `}` 切片 → JSON.parse。
// 消费者 schema 面 = zod 对象 schema（判定/产物均 z.object 形态）；顶层数组不在此支持面内。
// 错误面：无 JSON 对象 → Error('输出中无 JSON 对象')；语法错误 → SyntaxError 原样透出
//（调用方按需包装诊断——judge 直抛、插件面包装 PluginLlmStructuredError）。
export function extractJsonObject(raw: string): unknown {
  let text = String(raw ?? '').trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fence) text = fence[1]!.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('输出中无 JSON 对象')
  return JSON.parse(text.slice(start, end + 1))
}
