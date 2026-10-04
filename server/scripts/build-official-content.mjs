import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// 官方内容源是仓库根级构建上下文（随面板发版、git 评审管理），不是用户可写的平台状态——
// 产物 generated.ts 提交入库，fresh checkout 的 typecheck/test 不依赖本钩子（predev/pretest/
// prebuild 仅做再生成防漂移）。
const server = fileURLToPath(new URL('..', import.meta.url))
const root = path.resolve(server, '../official')
function entry(file) {
  const raw = readFileSync(file, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
  if (!match) throw new Error(`Missing official content frontmatter: ${file}`)
  const field = name => {
    const value = new RegExp(`^${name}: (.+)$`, 'm').exec(match[1])?.[1]?.trim()
    if (!value) throw new Error(`Missing ${name}: ${file}`)
    return value
  }
  return { name: field('name'), description: field('description'), body: match[2].trim() }
}
const commands = readdirSync(path.join(root, 'commands')).sort().filter(name => name.endsWith('.md')).map(name => entry(path.join(root, 'commands', name)))
const skills = readdirSync(path.join(root, 'skills'), { withFileTypes: true }).filter(dir => dir.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).map(dir => entry(path.join(root, 'skills', dir.name, 'SKILL.md')))
mkdirSync(path.join(server, 'src/officialContent'), { recursive: true })
writeFileSync(path.join(server, 'src/officialContent/generated.ts'), `// 由仓库根 official/ Markdown 生成（npm run content:build）。勿手改——发版评审改源目录后重新生成。\nexport const OFFICIAL_SOURCES = ${JSON.stringify({ commands, skills }, null, 2)} as const\n`)
