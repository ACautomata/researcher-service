// 插件目录注册期强校验（#752 §2.2/§2.3/§5 · #788）：fail-fast——校验失败 = 启动失败
//（编译期信任下无「装了一半」状态）。纯逻辑零 IO（接缝 S3）。
//
// 校验清单（§2.2 注册期强校验 + §2.3 保留字）：
//   - manifest id kebab-case + 全局唯一；name/description/version 非空
//   - 工具：category ∈ file|exec|domain 必填；file 类 pathParams 必填非空；工具名全局唯一
//     （核心 + 跨插件）；parameters 为 zod schema（safeParse 鸭子判定）；promptSnippet 单行
//   - 命令：名 regex + 不撞保留字（系统含官方目录，R4）+ 跨插件唯一；execute 引用合法
//    （只能引用本 manifest 已注册工具，注册期静态校验）
//   - configSchema.env 键名大写蛇形

import type { AnyPluginToolDefinition, PluginManifest, PluginToolCategory } from './api'

export const PLUGIN_ID_REGEX = /^[a-z][a-z0-9-]*$/
export const PLUGIN_COMMAND_NAME_REGEX = /^[a-z][a-z0-9-]*$/
export const PLUGIN_ENV_KEY_REGEX = /^[A-Z][A-Z0-9_]*$/

// 保留插件 id（#883 T3）：'judge' = 审批判定器指派行键（plugin_llm_assignments 收 judge 行，
// 执行面归后票）——非插件目录位，撞键 = 启动 fail-fast。
export const JUDGE_PLUGIN_ID = 'judge'
export const RESERVED_PLUGIN_IDS: ReadonlySet<string> = new Set([JUDGE_PLUGIN_ID])

export const TOOL_CATEGORIES: readonly PluginToolCategory[] = ['file', 'exec', 'domain']

export interface PluginCatalogValidationInput {
  readonly manifests: readonly PluginManifest[]
  /** 核心工具名集（deepagents 内建 + official read_official_skill + teammate 工具面）——
   *  工具名全局唯一的「核心」侧；装配层从真实工具面收集传入，不在此硬编码。 */
  readonly coreToolNames?: readonly string[]
  /** 保留命令名（系统命令 + 官方目录命令名，R4 两源无遮蔽的前提）。 */
  readonly reservedCommandNames?: readonly string[]
}

function isZodSchema(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { safeParse?: unknown }).safeParse === 'function'
}

function singleLine(value: string): boolean {
  return !/[\r\n]/.test(value)
}

export async function assertValidPluginCatalog(input: PluginCatalogValidationInput): Promise<void> {
  const seenIds = new Set<string>()
  const seenToolNames = new Set<string>(input.coreToolNames ?? [])
  const seenCommandNames = new Set<string>(input.reservedCommandNames ?? [])
  for (const manifest of input.manifests) {
    if (RESERVED_PLUGIN_IDS.has(manifest.id)) throw new Error(`Plugin id is reserved: ${manifest.id}`)
    if (!PLUGIN_ID_REGEX.test(manifest.id)) throw new Error(`Plugin id must be kebab-case: ${manifest.id}`)
    if (seenIds.has(manifest.id)) throw new Error(`Plugin id duplicate: ${manifest.id}`)
    seenIds.add(manifest.id)
    if (typeof manifest.name !== 'string' || manifest.name.trim() === '') throw new Error(`Plugin name required: ${manifest.id}`)
    if (typeof manifest.description !== 'string' || manifest.description.trim() === '') throw new Error(`Plugin description required: ${manifest.id}`)
    if (typeof manifest.version !== 'string' || manifest.version.trim() === '') throw new Error(`Plugin version required: ${manifest.id}`)
    assertLlmDeclarationValid(manifest)
    assertToolsValid(manifest, seenToolNames)
    await assertCommandsValid(manifest, seenCommandNames)
    assertConfigSchemaValid(manifest)
  }
}

// llm 声明位校验（#883）：description 必填单行非空；defaultModel 可选非空单行（UI 预填
// 参考，非运行时解析面）。
function assertLlmDeclarationValid(manifest: PluginManifest): void {
  const llm = manifest.llm
  if (llm === undefined) return
  if (typeof llm.description !== 'string' || llm.description.trim() === '' || !singleLine(llm.description)) {
    throw new Error(`plugin ${manifest.id}: llm.description must be a non-empty single line`)
  }
  if (llm.defaultModel !== undefined && (typeof llm.defaultModel !== 'string' || llm.defaultModel.trim() === '' || !singleLine(llm.defaultModel))) {
    throw new Error(`plugin ${manifest.id}: llm.defaultModel must be a non-empty single line when provided`)
  }
}

function assertToolsValid(manifest: PluginManifest, seenToolNames: Set<string>): void {
  for (const tool of manifest.tools ?? []) {
    assertToolValid(manifest, tool, seenToolNames)
  }
}

function assertToolValid(manifest: PluginManifest, tool: AnyPluginToolDefinition, seenToolNames: Set<string>): void {
  const where = `plugin ${manifest.id} tool ${String(tool?.name ?? '<unnamed>')}`
  if (typeof tool.name !== 'string' || tool.name.trim() === '') throw new Error(`${where}: name required`)
  if (seenToolNames.has(tool.name)) throw new Error(`Tool name not globally unique: ${tool.name} (${where})`)
  seenToolNames.add(tool.name)
  if (typeof tool.description !== 'string' || tool.description.trim() === '') throw new Error(`${where}: description required`)
  if (!TOOL_CATEGORIES.includes(tool.category)) throw new Error(`${where}: category must be one of file|exec|domain`)
  if (tool.category === 'file') {
    if (!Array.isArray(tool.pathParams) || tool.pathParams.length === 0 || tool.pathParams.some((p) => typeof p !== 'string' || p.trim() === '')) {
      throw new Error(`${where}: file-category tools must declare non-empty pathParams`)
    }
  }
  if (!isZodSchema(tool.parameters)) throw new Error(`${where}: parameters must be a zod schema`)
  if (tool.promptSnippet !== undefined && (typeof tool.promptSnippet !== 'string' || !singleLine(tool.promptSnippet))) {
    throw new Error(`${where}: promptSnippet must be a single line`)
  }
  if (tool.promptGuidelines !== undefined) {
    if (!Array.isArray(tool.promptGuidelines) || tool.promptGuidelines.some((g) => typeof g !== 'string' || !singleLine(g))) {
      throw new Error(`${where}: promptGuidelines must be single-line strings`)
    }
  }
  if (typeof tool.execute !== 'function') throw new Error(`${where}: execute must be a function`)
}

async function assertCommandsValid(manifest: PluginManifest, seenCommandNames: Set<string>): Promise<void> {
  for (const command of manifest.commands ?? []) {
    const where = `plugin ${manifest.id} command ${String(command?.name ?? '<unnamed>')}`
    if (typeof command.name !== 'string' || !PLUGIN_COMMAND_NAME_REGEX.test(command.name)) throw new Error(`${where}: invalid name`)
    if (seenCommandNames.has(command.name)) throw new Error(`Command name collides with a reserved or existing command: ${command.name} (${where})`)
    seenCommandNames.add(command.name)
    if (typeof command.handler !== 'function') throw new Error(`${where}: handler must be a function`)
    if (command.getArgumentCompletions !== undefined && typeof command.getArgumentCompletions !== 'function') {
      throw new Error(`${where}: getArgumentCompletions must be a function`)
    }
  }
  await assertExecuteReferencesValid(manifest)
}

// execute 引用合法性（R9「引用在注册期可静态校验」）：outcome 由 handler 运行期产出，
// 注册期以探针调用（空 args + 丢弃 ctx）取回 outcome——产出 {execute} 时校验 tool 引用
// 必须落在本 manifest 已注册工具集内（跨插件/不存在 = fail-fast）。探针抛错/返回非
// execute 形态 → 静态面不可判定，放行（运行期 dispatch 面仍会复核，双保险）。
async function assertExecuteReferencesValid(manifest: PluginManifest): Promise<void> {
  const ownTools = new Set((manifest.tools ?? []).map((tool) => tool.name))
  for (const command of manifest.commands ?? []) {
    if (typeof command.handler !== 'function') continue
    let outcome: unknown
    try {
      outcome = await command.handler('', { logger: { info: () => {}, warn: () => {} } })
    } catch {
      continue // 探针不可达（如强制要求参数）——静态面放行，运行期 dispatch 复核
    }
    if (typeof outcome !== 'object' || outcome === null || !('execute' in outcome)) continue
    const tool = (outcome as { execute: { tool?: unknown } }).execute?.tool
    if (typeof tool !== 'string' || !ownTools.has(tool)) {
      throw new Error(`plugin ${manifest.id} command ${command.name}: execute outcome references "${String(tool)}" which is not a tool of the same plugin`)
    }
  }
}

function assertConfigSchemaValid(manifest: PluginManifest): void {
  for (const key of manifest.configSchema?.env ?? []) {
    if (!PLUGIN_ENV_KEY_REGEX.test(key.name)) throw new Error(`plugin ${manifest.id}: env key must be UPPER_SNAKE_CASE: ${key.name}`)
  }
}

// ---------------------------------------------------------------------------
// 启动期 env 完备性（§5 R7）：对全部目录插件断言（不看启用位——任何用户随时可启用 =
// 面板必须永远备好）。生产缺 required env → fail-fast；dev → 警告照常收录。
// ---------------------------------------------------------------------------

export function assertPluginEnv(
  manifests: readonly PluginManifest[],
  opts: { readonly env: NodeJS.ProcessEnv; readonly production: boolean; readonly warn?: (message: string) => void },
): void {
  for (const manifest of manifests) {
    for (const key of manifest.configSchema?.env ?? []) {
      const present = opts.env[key.name] !== undefined && opts.env[key.name] !== ''
      if (present) {
        // 废弃键设值告警（#883）：键仍生效（解析链兼容面），退役由后续票收口。
        if (key.deprecated === true) {
          opts.warn?.(`Plugin ${manifest.id} env ${key.name} is deprecated and will be retired; prefer per-user plugin LLM assignment (model page)`)
        }
        continue
      }
      const message = `Plugin ${manifest.id} env ${key.name} is not set${key.required === false ? '' : ' (required)'}`
      if (key.required === false) continue
      if (opts.production) throw new Error(`Missing required plugin env: ${message}`)
      opts.warn?.(`${message} — dev mode continues with the plugin disabled at runtime`)
    }
  }
}
