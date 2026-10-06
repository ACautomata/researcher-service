// #797 S3：命令目录三源合并，通过菜单条目观察启用位与命名空间。
import { describe, expect, it } from 'vitest'
import { mergeSlashCommands } from './slashCommands'

describe('slash 命令目录', () => {
  it('包含系统和官方命令，仅收录启用插件的命令且不遮蔽官方名称', () => {
    const commands = mergeSlashCommands([
      { id: 'active', name: 'Active', description: '', version: '1', enabled: true, commands: [{ name: 'figure', description: '生成图' }, { name: 'research', description: '冲突' }] },
      { id: 'inactive', name: 'Inactive', description: '', version: '1', enabled: false, commands: [{ name: 'hidden', description: '不可见' }] },
    ])
    expect(commands.map(c => c.alias)).toEqual(['/new', '/compact', '/model', '/research', '/figure'])
    expect(commands.find(c => c.alias === '/research')).toMatchObject({ description: '调研问题并整理有来源的结论', argumentHint: '$ARGUMENTS：输入命令参数，作为用户消息发送' })
    expect(commands.find(c => c.alias === '/model')?.argumentHint).toContain('下一轮')
  })
})
