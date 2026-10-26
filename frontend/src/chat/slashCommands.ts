import type { PluginSummary } from '@/api/plugins'

export interface SlashOption { alias: string; description: string; argumentHint?: string; pluginId?: string }

export const SYSTEM_COMMANDS: readonly SlashOption[] = [
  { alias: '/new', description: '新建会话' },
  { alias: '/compact', description: '压缩上下文后继续' },
  { alias: '/model', description: '查看/切换模型', argumentHint: '留空查看模型；输入 providerId/modelId 切换，下一轮对话生效' },
]

/** 超星内置能力命令：仅在部署已配置超星接入时进入菜单（不依赖插件启用位）。 */
export const CHAOXING_COMMANDS: readonly SlashOption[] = [
  { alias: '/course-search', description: '查询超星课程资料', argumentHint: '例如：/course-search 可视化（在已同步课程中搜索；首次请到账号设置同步课程）' },
  { alias: '/topic-search', description: '查询超星已有知识点（首版暂缓）', argumentHint: '知识点权限尚未确认，请先使用 /course-search 查询课程资料' },
]

export interface SlashCommandOptions {
  /** 部署已配置超星接入（configured，不要求用户已绑定）——未配置不展示可执行入口。 */
  chaoxingConfigured?: boolean
}

/** 系统命令优先，内置能力命令按部署开关，插件启用位过滤；技能目录不派生命令。 */
export function mergeSlashCommands(
  plugins: readonly PluginSummary[],
  options: SlashCommandOptions = {},
): SlashOption[] {
  const commands = new Map<string, SlashOption>()
  for (const c of SYSTEM_COMMANDS) commands.set(c.alias, c)
  if (options.chaoxingConfigured) {
    for (const c of CHAOXING_COMMANDS) commands.set(c.alias, c)
  }
  for (const plugin of plugins) {
    if (!plugin.enabled) continue
    for (const c of plugin.commands) {
      const alias = `/${c.name}`
      if (!commands.has(alias)) commands.set(alias, { alias, description: c.description, ...(c.hasArgumentCompletions ? { pluginId: plugin.id } : {}) })
    }
  }
  return [...commands.values()]
}
