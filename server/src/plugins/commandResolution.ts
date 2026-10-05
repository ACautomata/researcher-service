// 命令两源合并纯函数（#752 §2.3 R4 · #788）：系统（含官方内容目录）> 插件，无遮蔽。
// 系统命令（/new /compact /model）在 sendMessage 更早分支分派，不入本目录；官方与插件
// 撞名在注册期校验已拒（plugins/registry reservedCommandNames）——本函数的官方优先序是
// 防御性兜底（测试锁），非运行时常规路径。
//
// #758 修订：用户命令源随 commands REST 域整域退役消失——两源即终态（R4 修订）。

import type { PluginCommandEntry } from './surface'

export interface OfficialCommandRef {
  readonly name: string
  readonly description?: string
}

export type ResolvedCommandEntry =
  | { readonly source: 'official'; readonly name: string; readonly description?: string }
  | { readonly source: 'plugin'; readonly entry: PluginCommandEntry }

export function mergeCommandDirectories(p: {
  readonly official: readonly OfficialCommandRef[]
  readonly plugin: readonly PluginCommandEntry[]
}): ReadonlyMap<string, ResolvedCommandEntry> {
  const out = new Map<string, ResolvedCommandEntry>()
  for (const command of p.official) {
    out.set(command.name, { source: 'official', name: command.name, ...(command.description !== undefined ? { description: command.description } : {}) })
  }
  for (const entry of p.plugin) {
    if (!out.has(entry.command.name)) out.set(entry.command.name, { source: 'plugin', entry })
  }
  return out
}
