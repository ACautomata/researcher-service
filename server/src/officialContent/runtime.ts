// 官方内容目录的运行时面（#787）：快照构造 + read_official_skill 工具。
//
// snapshotOfficialContent = 「目录快照 per-run」语义的实现点：OFFICIAL_SOURCES 是编译期常量
//（generated.ts，随面板发版），目录含 version=sha256 入图缓存键——同发版内构造结果恒等，
// 故模块级 memo 构造一次（校验含 50/4KB/64KB 护栏，失败在首次调用即抛，不发版不改源不会变）。
import { tool } from 'langchain'
import { z } from 'zod'
import { createOfficialCatalog } from './catalog'
import { OFFICIAL_SOURCES } from './generated'

export type OfficialCatalog = ReturnType<typeof createOfficialCatalog>

let memo: OfficialCatalog | undefined
export function snapshotOfficialContent(): OfficialCatalog {
  return (memo ??= createOfficialCatalog(OFFICIAL_SOURCES))
}

// 渐进披露工具（story 46）：目录行进 system prompt，正文只经本工具按需读取——
// 未命中回 JSON 错误标记（不抛，模型可据提示自纠；工具面异常统一序列化形态）。
export function officialSkillTools(catalog: OfficialCatalog) {
  return [tool(async ({ name }) => {
    try { return catalog.readSkill(name) }
    catch { return JSON.stringify({ ok: false, error: 'Unknown official skill; use a name listed in the system prompt.' }) }
  }, { name: 'read_official_skill', description: 'Read an official skill body by the exact name in the skill directory.', schema: z.object({ name: z.string().max(100) }) })]
}
