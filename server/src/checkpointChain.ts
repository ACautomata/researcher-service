// checkpoint 父链行走（共享内核纯逻辑）：sessions/rewind（归档/复制判定）与 runner（指针推进
// 守卫）的单一实现——CONTEXT.md「无 IO 纯函数下沉共享内核……在 context 间不得复制共享内核
// 纯知识」。环与超深链 guard 兜底（脏数据不炸、不死循环）。

const MAX_CHAIN_DEPTH = 10_000

// start 出发沿 parentOf 上溯的祖先集（含 start 自身）。
export function ancestorChainOf(parentOf: (id: string) => string | null, start: string): Set<string> {
  const seen = new Set<string>()
  let cur: string | null = start
  while (cur !== null && !seen.has(cur) && seen.size < MAX_CHAIN_DEPTH) {
    seen.add(cur)
    cur = parentOf(cur)
  }
  return seen
}
