import type { PluginSummary } from '@/api/plugins'
import { OFFICIAL_COMMANDS } from './officialCommands.generated'

export interface SlashOption { alias: string; description: string; argumentHint?: string; pluginId?: string }

export const SYSTEM_COMMANDS: readonly SlashOption[] = [
  { alias: '/new', description: '新建会话' },
  { alias: '/compact', description: '压缩上下文后继续' },
  { alias: '/model', description: '查看/切换模型', argumentHint: '留空查看模型；输入 providerId/modelId 切换，下一轮对话生效' },
]

/** 系统含官方目录优先，插件启用位过滤；技能目录不派生命令。 */
export function mergeSlashCommands(plugins: readonly PluginSummary[]): SlashOption[] {
  const commands = new Map<string, SlashOption>()
  for (const c of SYSTEM_COMMANDS) commands.set(c.alias, c)
  for (const c of OFFICIAL_COMMANDS) {
    const alias = `/${c.name}`
    if (!commands.has(alias)) commands.set(alias, {
      alias, description: c.description,
      ...(c.takesArguments ? { argumentHint: '$ARGUMENTS：输入命令参数，作为用户消息发送' } : {}),
    })
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
