// wiki 显示层常量单源（#954）：与服务端 server/src/wiki/values.ts 值域契约对齐
// （读面归组不回写；服务端树分组唯一来源，前端 eyebrow 灰显 / 树折叠默认同源判定）。
// status 中文徽标为纯显示层映射——数据层英文值不可动（检索 deprecated 剔除依赖英文值）。
export const WIKI_CATEGORIES = ['论文', '科学问题', '假说', '实验报告'] as const
export const WIKI_UNCATEGORIZED = '未分类'

export const WIKI_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  stable: '稳定',
  deprecated: '已弃用',
}
