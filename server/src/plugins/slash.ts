// 系统命令设施（#952 T1·prefactor 自 officialContent/catalog 迁出，#938 Q3 拍板落点）：
// /new /compact /model 三系统命令的名称常量 + 斜杠解析纯函数。官方内容退役（T5）后独立存活。
export const SYSTEM_COMMANDS = ['new', 'compact', 'model'] as const
export function parseSlash(text: string): { name: string; args: string } | undefined {
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return match ? { name: match[1]!, args: (match[2] ?? '').trim() } : undefined
}
