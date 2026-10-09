// t() 本地 shim：替代官方 tool-call-grouping 依赖的 ui/src/i18n 状态式 I18nManager
//（带 localStorage/document 副作用 + 异步语言包，面板无此体系）。只含聚合摘要所需
// 中文文案表 + {count}/{names} 插值，key 沿用官方 `chat.toolCards.group.*`(#555 移植注意 3a)。
// 文案表来源：docs/research/555-official-tool-call-files.md §G（ui/src/i18n/locales/en.ts）。

const TOOL_GROUP_MESSAGES: Record<string, string> = {
  'chat.toolCards.group.commandsOne': '执行 1 条命令',
  'chat.toolCards.group.commandsMany': '执行 {count} 条命令',
  'chat.toolCards.group.readsOne': '读取 1 个文件',
  'chat.toolCards.group.readsMany': '读取 {count} 个文件',
  'chat.toolCards.group.editsOne': '编辑 1 个文件',
  'chat.toolCards.group.editsMany': '编辑 {count} 个文件',
  'chat.toolCards.group.writesOne': '创建 1 个文件',
  'chat.toolCards.group.writesMany': '创建 {count} 个文件',
  'chat.toolCards.group.searchesOne': '搜索 1 次',
  'chat.toolCards.group.searchesMany': '搜索 {count} 次',
  'chat.toolCards.group.fetchesOne': '获取 1 个页面',
  'chat.toolCards.group.fetchesMany': '获取 {count} 个页面',
  'chat.toolCards.group.namedTool': '调用 {names}',
  'chat.toolCards.group.namedToolRepeated': '调用 {names} ×{count}',
  'chat.toolCards.group.otherOne': '调用 1 个工具',
  'chat.toolCards.group.otherMany': '调用 {count} 个工具',
  'chat.toolCards.group.emptyOne': '执行 1 次工具调用',
  'chat.toolCards.group.emptyMany': '执行 {count} 次工具调用',
  'chat.toolCards.group.failedOne': '{count} 次失败',
  'chat.toolCards.group.failedMany': '{count} 次失败',
}

export function t(key: string, params?: Record<string, string>): string {
  let template = TOOL_GROUP_MESSAGES[key] ?? key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      template = template.replaceAll(`{${name}}`, value)
    }
  }
  return template
}
