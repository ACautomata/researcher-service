// 可信管理意图判定（#1082 · 父规格 I6）：只读真实触发用户消息，不从模型 purpose 参数推导。
// 保守白名单：明确指向“我的反思/经验记录”的查看、列出、整理、管理意图。
const PATTERNS: readonly RegExp[] = [
  /(管理|查看|列出|整理|检索|查一下|看一下|删除|停用|恢复).{0,8}(我的|本人)?.{0,4}(反思记录|反思经验|经验记录)/,
  /(我的|本人).{0,4}(反思记录|反思经验|经验记录)/,
  /(manage|list|review|show|delete|deactivate|reactivate)\s+(my\s+)?(reflections?|experience)s?\b/i,
]

export function hasReflectionManagementIntent(message: string): boolean {
  const text = message.normalize('NFKC')
  return PATTERNS.some((pattern) => pattern.test(text))
}
