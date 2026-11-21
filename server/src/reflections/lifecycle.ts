// 生命周期只改变使用状态；证据有效性独立，硬删边界随确认动作展示。
export function isLifecycleAction(action: string): boolean {
  return ['deactivate', 'reactivate', 'delete'].includes(action)
}

export const REFLECTION_DELETE_BOUNDARY = '不可恢复地删除在线反思存储及系统管理的正文、修订、草稿、证据、展示、索引缓存和重试副本。普通对话独立文字、外部导出、截图、第三方及备份不承诺全副本抹除。合并派生记录独立保留，按各自原始证据判断有效性。'

export class ReflectionDraftLimitError extends Error {}
