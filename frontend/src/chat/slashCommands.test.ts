// #797 S3：命令目录二源合并（系统 + 启用插件），通过菜单条目观察启用位与命名空间。
import { describe, expect, it } from 'vitest'
import { mergeSlashCommands } from './slashCommands'

describe('slash 命令目录', () => {
  it('包含系统和启用插件的命令，插件不遮蔽系统命令名称', () => {
    const commands = mergeSlashCommands([
      { id: 'active', name: 'Active', description: '', version: '1', enabled: true, commands: [{ name: 'figure', description: '生成图' }, { name: 'new', description: '冲突' }] },
      { id: 'inactive', name: 'Inactive', description: '', version: '1', enabled: false, commands: [{ name: 'hidden', description: '不可见' }] },
    ])
    expect(commands.map(c => c.alias)).toEqual(['/new', '/compact', '/model', '/figure'])
    expect(commands.find(c => c.alias === '/new')).toMatchObject({ description: '新建会话' })
    expect(commands.find(c => c.alias === '/model')?.argumentHint).toContain('下一轮')
  })
})
