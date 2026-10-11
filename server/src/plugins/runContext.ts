// 插件 run frame（#792 · #744 §11.1「run 装配注入」）：run 执行体外层置位的 per-run
// 上下文——agent 自动调用路径的 ctx 六件解析源。图实例跨 run 复用（图缓存），ctx 六件
// 不能构造期绑定 run 身份——ALS 运行期读取是唯一非侵入通道（approval funnel / journaling
// 的 runtime 读取面同一纪律）。
//
// {execute} 直达路径不经 ALS：RunService 显式构造六件后直接传入 exec（同一 frame 构造面）。
// frame 缺失（注册期探针/无 runner 上下文）→ ctx 六件 undefined，域工具执行时自校验。

import { AsyncLocalStorage } from 'node:async_hooks'
import type { PluginAuditPort, PluginDocsPort, PluginFiguresPort, PluginLlmPort, PluginRunIdentity, PluginToolContext, PluginWikiPort } from './api'

export interface PluginRunFrame {
  readonly run: PluginRunIdentity
  readonly figures: PluginFiguresPort
  /** per-plugin ctx.llm 工厂（#883 T3）：插件 id → 解析器端口。端口内绑定 run 启动捕获的
   *  配置快照（frame 构造期）——指派变更下一 run 生效，在飞 run 不受影响。 */
  readonly llmFor: (pluginId: string) => PluginLlmPort
  readonly audit: PluginAuditPort
  /** per-plugin ctx.wiki 工厂（#908 · 853 §3.2#1）：插件 id → PluginWikiPort。per-plugin
   *  的理由 = frontmatter 溯源 source 盖章（assemblePageMarkdown 的 source = 调用插件 id，
   *  与 generated.by 同源）——盖章要插件身份，显式工厂优于 toolCallId 反查魔法（镜像 llmFor
   *  先例）。ownerId/run 身份/原语/ensure 绑定 run，frame 构造期注入。 */
  readonly wikiFor: (pluginId: string) => PluginWikiPort
  /** run 级 ctx.docs（#908 · 853 §3.2#2）：extractPdfText 无 per-plugin 面——沙箱容器 +
   *  固定 pdftotext 命令 + /lab 白名单，全 run 常量，单例直挂。 */
  readonly docs: PluginDocsPort
  /** run abort 传播（#853 §3.2#4）：frame 持有的 run signal——形状契约面（spec 点名
   *  frame 携带，供未来消费面读取）。abort 到 LLM invoke 的实际传导不走本字段直读：
   *  buildPluginRunFrame 构造期把同一 signal 闭包捕获进 llmFor 的 createLlmToolPort
   *  （构造入参——invoke options 自动透传，generateMultimodal/generateStructured 签名
   *  不出现 signal，插件零感知、结构性防忘传；顺带修 autofigure abort 后照跑照计费
   *  缺口）。与 PluginToolExec.signal 同一 signal 实例。 */
  readonly signal: AbortSignal
  /** 翻译面注册（#853 §3.2#6）：toolCallId → 工具名——onUpdate 白名单查表「toolCallId→
   *  工具名→所属插件」的第一跳。可选：注册面缺失（旧形状 frame/探针）时 stage 上报按
   *  白名单外丢弃语义自然落空。 */
  readonly noteToolCall?: (toolCallId: string, toolName: string) => void
  /** 阶段/部分结果上报（runner 翻译面：progress SSE + stage_transitions TextTrace 双面） */
  readonly onUpdate: (toolCallId: string, partial: unknown) => void
}

const storage = new AsyncLocalStorage<PluginRunFrame>()

export function runWithPluginRunFrame<T>(frame: PluginRunFrame | undefined, fn: () => T): T {
  return frame === undefined ? fn() : storage.run(frame, fn)
}

export function currentPluginRunFrame(): PluginRunFrame | undefined {
  return storage.getStore()
}

// frame → execute exec 面件（ctx 六件展开 + onUpdate 单参包装）——agent 路径（tools.ts
// ALS 解析）与 {execute} 直达路径（RunService 显式构造）的单一共享实现。frame 缺省 =
// ctx 最小面（config/logger）+ 无 onUpdate，域工具自校验明确报错。pluginId 缺失（目录外
// 工具名，防御面）→ llm 缺省——per-plugin 解析无键可用，宁缺不误。
export function execPartsFromFrame(
  ctx: PluginToolContext,
  frame: PluginRunFrame | undefined,
  toolCallId: string,
  pluginId?: string,
): { readonly ctx: PluginToolContext; readonly onUpdate?: (partial: unknown) => void } {
  if (!frame) return { ctx }
  const llm = pluginId !== undefined ? frame.llmFor(pluginId) : undefined
  const wiki = pluginId !== undefined ? frame.wikiFor(pluginId) : undefined
  return {
    ctx: {
      ...ctx,
      run: frame.run,
      figures: frame.figures,
      ...(llm !== undefined ? { llm } : {}),
      audit: frame.audit,
      // wiki per-plugin 解析（source 盖章）；docs run 级直挂。pluginId 缺失（目录外工具名
      // 防御面）→ wiki 缺省（docs 仍在——无 per-plugin 面，宁缺不误只适用于有键依赖的件）。
      ...(wiki !== undefined ? { wiki } : {}),
      docs: frame.docs,
    },
    onUpdate: (partial: unknown) => frame.onUpdate(toolCallId, partial),
  }
}
