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

  it('超星已配置时展示两条中文命令，插件不得同名覆盖', () => {
    const commands = mergeSlashCommands([
      { id: 'active', name: 'Active', description: '', version: '1', enabled: true, commands: [{ name: 'course-search', description: '插件同名' }, { name: 'topic-search', description: '插件同名' }] },
    ], { chaoxingConfigured: true })
    expect(commands.map(c => c.alias)).toEqual(['/new', '/compact', '/model', '/course-search', '/topic-search'])
    expect(commands.find(c => c.alias === '/course-search')).toMatchObject({ description: '查询超星课程资料', argumentHint: expect.stringContaining('--class-id') })
    expect(commands.find(c => c.alias === '/topic-search')).toMatchObject({ description: '查询超星已有知识点（首版暂缓）', argumentHint: expect.stringContaining('请先使用 /course-search') })
  })

  it('超星未配置时菜单不提供可执行入口', () => {
    const commands = mergeSlashCommands([], { chaoxingConfigured: false })
    expect(commands.map(c => c.alias)).toEqual(['/new', '/compact', '/model'])
  })
})
