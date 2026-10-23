import { chaoxingLearnSchema } from '../validation/schemas'
import type { ChaoxingQueryTarget, LearningResult } from './remote'

export type ChaoxingCommandTarget = Extract<ChaoxingQueryTarget, 'resources' | 'topics'>

export const CHAOXING_COMMANDS = {
  'course-search': {
    target: 'resources',
    description: '查询超星课程资料',
    argumentHint: 'HTTP 模式：/course-search --course-id 课程ID --class-id 班级ID 梯度下降',
    usage: '用法：/course-search <关键词>；HTTP 模式：/course-search --course-id <课程ID> --class-id <班级ID> <关键词>',
  },
  'topic-search': {
    target: 'topics',
    description: '查询超星已有知识点',
    argumentHint: 'HTTP 模式：/topic-search --course-id 课程ID 导数',
    usage: '用法：/topic-search <关键词>；HTTP 模式：/topic-search --course-id <课程ID> <关键词>',
  },
} as const satisfies Record<string, { target: ChaoxingCommandTarget; description: string; argumentHint: string; usage: string }>

export type ChaoxingCommandName = keyof typeof CHAOXING_COMMANDS
export const CHAOXING_COMMAND_NAMES = Object.keys(CHAOXING_COMMANDS) as ChaoxingCommandName[]

export function chaoxingCommand(name: string) {
  if (!Object.hasOwn(CHAOXING_COMMANDS, name)) return undefined
  return (CHAOXING_COMMANDS as Record<string, (typeof CHAOXING_COMMANDS)[ChaoxingCommandName] | undefined>)[name]
}

/** 仅解析关键词前的显式选择参数；不接受 owner、token 或角色覆盖。 */
export function parseChaoxingCommandArgs(args: string) {
  let rest = args.trim()
  const ids: { courseId?: string; classId?: string } = {}
  while (rest.startsWith('--')) {
    const match = /^--(course-id|class-id)\s+([1-9][0-9]{0,29})(?:\s+|$)/.exec(rest)
    if (!match) return undefined
    const key = match[1] === 'course-id' ? 'courseId' : 'classId'
    if (ids[key]) return undefined
    ids[key] = match[2]
    rest = rest.slice(match[0].length).trim()
  }
  const parsed = chaoxingLearnSchema.safeParse({ topic: rest, ...ids })
  return parsed.success ? parsed.data : undefined
}

/** 直跑路径的工具卡名称：与触发命令一一对应。 */
export const CHAOXING_COMMAND_TOOLS: Record<ChaoxingCommandTarget, string> = {
  resources: 'chaoxing_course_search',
  topics: 'chaoxing_topic_search',
}

const plain = (value: string, max: number): string => {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 确定性命令结果：资源名称/ID/课程/链接（知识点另给说明）。 */
export function formatChaoxingCommandResult(target: ChaoxingCommandTarget, topic: string, result: LearningResult): string {
  const label = target === 'resources' ? '课程资料' : '已有知识点'
  const limitations = result.limitations.length > 0 ? ['', ...result.limitations.map(item => `> ${plain(item, 300)}`)] : []
  if (result.resources.length === 0) return [`未找到与「${plain(topic, 200)}」相关的超星${label}。`, ...limitations].join('\n')
  const lines = [`**超星${label}**（${result.resources.length} 条）`, '']
  result.resources.forEach((resource, index) => {
    lines.push(`${index + 1}. **${plain(resource.name, 300)}**`)
    lines.push(`   - ID：${plain(resource.id, 200)}`)
    lines.push(`   - 课程：${plain(resource.courseName, 200)}`)
    if (resource.text) lines.push(`   - ${resource.kind === 'topic' ? '说明' : '正文摘要'}：${plain(resource.text, target === 'resources' ? 160 : 300)}`)
    lines.push(`   - 链接：${resource.url ?? '未提供'}`)
  })
  lines.push(...limitations)
  return lines.join('\n')
}
