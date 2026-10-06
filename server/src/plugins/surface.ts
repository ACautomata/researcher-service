// 插件运行时装配面（#752 §4.2 · #788）：编译期全量目录 → run 粒度启用集静态过滤。
// 禁用语义 = 新 run 装配不再纳入（工具/命令/promptSnippet）；进行中 run 不中断（工具集
// 已随 run 快照入图）；历史回放不受影响（投影行自带渲染数据）。teammate 继承 = 同一
// per-run 快照读 owner 启用集（#823 capabilities 消费面不变）。

import { createHash } from 'node:crypto'
import type { AnyPluginToolDefinition, PluginCommandDefinition, PluginManifest, PluginToolCategory, PluginToolContext } from './api'

// 漏斗路由 spec（§3）：category 是路由键；pathParams 是 file 类规则层校验目标。
export interface PluginToolSpec {
  readonly category: PluginToolCategory
  readonly pathParams?: readonly string[]
}

export interface PluginCommandEntry {
  readonly manifestId: string
  readonly command: PluginCommandDefinition
}

export interface EnabledPluginSurface {
  readonly enabledIds: readonly string[]
  readonly tools: readonly AnyPluginToolDefinition[]
  readonly commands: readonly PluginCommandEntry[]
  /** 系统 prompt 插件段（promptSnippet + guidelines；空集 = 空串不入拼接）。 */
  readonly prompt: string
}

export const PLUGIN_PROMPT_MAX_BYTES = 4096

export interface PluginRuntime {
  readonly manifests: readonly PluginManifest[]
  /** 目录版本（id+version 序列化 sha256）——图缓存键因子（目录发版 → 图重建）。 */
  readonly catalogVersion: string
  readonly toolContext: PluginToolContext
  /** 全目录工具 spec（漏斗路由用，§3）。按全目录而非启用集路由：禁用插件的工具根本
   *  不会出现在图内，图内出现即启用态——全目录路由不会放大审批面。 */
  readonly toolSpecByName: ReadonlyMap<string, PluginToolSpec>
  /** run 粒度启用集静态过滤（§4.2 纯函数）。 */
  surface(enabledIds: readonly string[]): EnabledPluginSurface
}

// 系统 prompt 插件段（目录行形态对齐 officialContent catalog.prompt 先例）。
export function buildPluginPrompt(manifests: readonly PluginManifest[]): string {
  const lines: string[] = []
  for (const manifest of manifests) {
    for (const tool of manifest.tools ?? []) {
      if (tool.promptSnippet === undefined) continue
      lines.push(`- ${tool.name}: ${tool.promptSnippet}`)
      for (const guideline of tool.promptGuidelines ?? []) {
        lines.push(`  - ${guideline}`)
      }
    }
  }
  if (lines.length === 0) return ''
  return ['Enabled plugin tools:', ...lines].join('\n')
}

// ctx.config 解析（§5 V1：面板级 env）——声明键 → env 值（缺失 = 空串；启动期完备性由
// assertPluginEnv 断言，此处不做第二重校验）。
export function resolvePluginConfig(manifests: readonly PluginManifest[], env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const manifest of manifests) {
    for (const key of manifest.configSchema?.env ?? []) {
      if (!(key.name in out)) out[key.name] = env[key.name] ?? ''
    }
  }
  return out
}

export function createPluginRuntime(input: {
  readonly manifests: readonly PluginManifest[]
  readonly config: Readonly<Record<string, string>>
  readonly logger?: { readonly info: (message: string) => void; readonly warn: (message: string) => void }
}): PluginRuntime {
  const { manifests } = input
  const toolSpecByName = new Map<string, PluginToolSpec>()
  for (const manifest of manifests) {
    for (const tool of manifest.tools ?? []) {
      toolSpecByName.set(tool.name, { category: tool.category, ...(tool.pathParams !== undefined ? { pathParams: tool.pathParams } : {}) })
    }
  }
  const prompt = buildPluginPrompt(manifests)
  if (Buffer.byteLength(prompt, 'utf8') > PLUGIN_PROMPT_MAX_BYTES) {
    throw new Error('Plugin promptSnippet section exceeds 4KB')
  }
  const toolContext: PluginToolContext = { config: input.config, logger: input.logger ?? { info: () => {}, warn: () => {} } }
  return {
    manifests,
    catalogVersion: createHash('sha256').update(JSON.stringify(manifests.map((m) => ({ id: m.id, version: m.version })))).digest('hex'),
    toolContext,
    toolSpecByName,
    surface(enabledIds: readonly string[]): EnabledPluginSurface {
      const enabled = new Set(enabledIds)
      const active = manifests.filter((manifest) => enabled.has(manifest.id))
      return {
        enabledIds: [...enabledIds],
        tools: active.flatMap((manifest) => [...(manifest.tools ?? [])]),
        commands: active.flatMap((manifest) => (manifest.commands ?? []).map((command) => ({ manifestId: manifest.id, command }))),
        prompt: buildPluginPrompt(active),
      }
    },
  }
}
