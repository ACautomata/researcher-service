import { createHash } from 'node:crypto'

export interface ContentEntry { readonly name: string; readonly description: string; readonly body: string }
export interface OfficialSources { readonly commands: readonly ContentEntry[]; readonly skills: readonly ContentEntry[] }
export const SYSTEM_COMMANDS = ['new', 'compact', 'model'] as const
export function parseSlash(text: string): { name: string; args: string } | undefined {
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return match ? { name: match[1]!, args: (match[2] ?? '').trim() } : undefined
}

/** run 粒度不可变快照（#787 story 46）：构造期完成全部护栏校验，正文不进 system prompt——
 * 目录行（name: description）经 prompt 字段注入，正文只经 readSkill 渐进披露。 */
export function createOfficialCatalog(sources: OfficialSources) {
  if (sources.skills.length > 50) throw new Error('Official skills exceed 50 entries')
  for (const [kind, entries] of [['commands', sources.commands], ['skills', sources.skills]] as const) {
    const seen = new Set<string>()
    for (const entry of entries) {
      if (!/^[a-z][a-z0-9-]*$/.test(entry.name)) throw new Error('Invalid official content name')
      if (seen.has(entry.name)) throw new Error('Official content duplicate name')
      if (kind === 'commands' && (SYSTEM_COMMANDS as readonly string[]).includes(entry.name)) throw new Error('Official command uses a reserved system name')
      if (Buffer.byteLength(entry.body, 'utf8') > 65536) throw new Error('Official content body exceeds 64KB')
      if (!entry.description.trim() || /[\r\n]/.test(entry.description)) throw new Error('Official description must be one line')
      seen.add(entry.name)
    }
  }
  const commands = new Map(sources.commands.map(entry => [entry.name, { ...entry }]))
  const skills = new Map(sources.skills.map(entry => [entry.name, { ...entry }]))
  const prompt = sources.skills.length
    ? ['Official skills (always available):', ...sources.skills.map(entry => `${entry.name}: ${entry.description}`), 'When a skill applies, call read_official_skill with its name before following it.'].join('\n')
    : ''
  if (Buffer.byteLength(prompt, 'utf8') > 4096) throw new Error('Official skill directory exceeds 4KB')
  return {
    prompt,
    version: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
    commands: sources.commands.map(({ name, description }) => ({ name, description })),
    expand(text: string): string {
      const slash = parseSlash(text)
      const command = slash && commands.get(slash.name)
      return command ? command.body.replaceAll('$ARGUMENTS', slash!.args) : text
    },
    readSkill(name: string): string {
      const skill = skills.get(name)
      if (!skill) throw new Error('Unknown official skill')
      return skill.body
    },
  }
}
