// 插件工具 → LangChain StructuredTool 适配（#752 §2.2 · #788；#792 校准 toolCallId 与
// ctx 四件）：manifest 声明 + zod parameters → deepagents 图工具集可消费形态。
//
// 双面契约落位（R5/R6）：content = 模型面（text 块拼接；image_url 块 V1 以占位行表达——
// 图片进模型上下文的物化形态随 #753 figure 首个消费者校准）；details 经 LangChain 原生
// ContentAndArtifact 的 artifact 通道透传 → ToolMessage.artifact → projector tool.end
// details（≤4KB 截断 + 截断标记，投影管线零特判复用）。
//
// #792 两处校准：
//   - toolCallId = 真实 tool_call_id（journal-tool-call-context 中间件 ALS 盖印——agent loop
//     内所有工具执行外层已置位；#744 §5.3 幂等去重身份同源）。ALS 缺失（非 agent 路径）
//     降级随机 id（占位满足签名，正确性无损）。
//   - ctx 六件 / onUpdate 从 plugin run frame（ALS）解析——图实例跨 run 复用，run 身份
//     只能运行期读取（runContext.ts 头注）。frame 缺失 = ctx 最小面（config/logger），
//     域工具自校验明确报错。

import { randomUUID } from 'node:crypto'
import { tool } from '@langchain/core/tools'
import { GraphInterrupt, interrupt } from '@langchain/langgraph'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'
import type { AnyPluginToolDefinition, PluginToolContentBlock, PluginToolContext } from './api'
import { currentPluginRunFrame, execPartsFromFrame } from './runContext'
import { currentToolCallContext } from '../runner/filejournal/context'

export function contentToText(content: readonly PluginToolContentBlock[]): string {
  return content
    .map((block) => (block.type === 'text' ? block.text : `[image: ${block.image_url.url}]`))
    .join('\n')
}

// 插件工具错误回喂文本的消息截断上限（describeRunError 同款纪律——防 docker/堆栈级超长
// 消息撑爆模型上下文；全量错误已由各插件 execute 的 console/审计留痕）。
const TOOL_ERROR_MESSAGE_MAX_LEN = 500

// agent 图执行上下文检测（#912 · 853 §5.1）：工具 runtime 即主 agent 图 pregel config——
// configurable 带 __pregel_checkpointer = 图内可挂起（interrupt 可恢复）；{execute} 命令
// 直达不经图（runtime 无 checkpointer）= 不可挂起。interrupt 经 runWithConfig 恢复主图
// ALS 后调顶层 interrupt——GraphInterrupt 从工具栈穿透嵌套路由图 invoke 冒泡主 agent 图
// 挂起（checkpoint 落库）；resume 重放时同闭包返回历史 resume 值。
//
// 返回面 = {value, historical}（#912 review 修复）：historical = 本次消费的是 resume 队列
// 的历史值（callIdx <= scratchpad.resume.length——LangGraph 队列语义：interruptCounter 0 基
// 递增，历史消费条件 idx < resume.length，idx = callIdx - 1；每次重放消费历史值至队列末位
// 前，末位对应新挂起点）——历史轮跳过审计落行，保「3 轮修订 = 3 行」于多轮重放。
// callIdx 为包装实例的调用计数（每次 resume 重放 = 新工具执行 = 新实例，从 1 起）。
export const graphInterruptOf = (runtime: unknown): ((value: unknown) => { value: unknown; historical: boolean }) | undefined => {
  const configurable = (runtime as { configurable?: Record<string, unknown> } | null | undefined)?.configurable
  if (configurable === undefined || !('__pregel_checkpointer' in configurable)) return undefined
  let callIdx = 0
  return (value: unknown) => {
    callIdx += 1
    const scratchpad = (configurable as { __pregel_scratchpad?: { resume?: unknown[] } }).__pregel_scratchpad
    const resumeLen = Array.isArray(scratchpad?.resume) ? scratchpad.resume.length : 0
    const result = AsyncLocalStorageProviderSingleton.runWithConfig(runtime, () => interrupt(value))
    return { value: result, historical: callIdx <= resumeLen }
  }
}

export function toLangChainTool(def: AnyPluginToolDefinition, ctx: PluginToolContext, pluginId?: string) {
  return tool(
    // func 签名（input, runtime)：runtime = RunnableConfig 扩展——signal 在 config 顶层或
    // configurable 两处随版本漂移，双处 best-effort 提取，缺省 never-abort。
    async (params: unknown, runtime: { signal?: AbortSignal; configurable?: { signal?: AbortSignal } }) => {
      const toolCallId = currentToolCallContext()?.toolCallId || randomUUID()
      const signal = runtime?.signal instanceof AbortSignal
        ? runtime.signal
        : runtime?.configurable?.signal instanceof AbortSignal
          ? runtime.configurable.signal
          : new AbortController().signal
      const frame = currentPluginRunFrame()
      // 翻译面注册（#853 §3.2#6）：onUpdate 白名单查表「toolCallId→工具名→所属插件」的
      // 第一跳——注册面缺失（旧形状 frame）时 stage 上报按白名单外丢弃语义自然落空。
      frame?.noteToolCall?.(toolCallId, def.name)
      const graphInterrupt = graphInterruptOf(runtime)
      let result: Awaited<ReturnType<typeof def.execute>>
      try {
        result = await def.execute(toolCallId, params as never, {
          signal,
          // W4 方案人审挂起点（#912）：仅 agent 图内可挂起；命令直达 undefined（W4 返回
          // clarify 引导 NL——无条件人审不破）。
          ...(graphInterrupt !== undefined ? { interrupt: graphInterrupt } : {}),
          // pluginId（#883）：调用方经运行时目录 toolOwnerByName 派生——ctx.llm per-plugin
          // 解析键。缺失（防御面）→ ctx.llm 缺省，域工具自校验。
          ...execPartsFromFrame(ctx, frame, toolCallId, pluginId),
        })
      } catch (e) {
        // 插件工具错误回喂（#737「Result 永不 throw」补齐——wikisearch 先例）：workflow
        // 图内失败转译为模型可读文本回喂主 agent，agent 自行消化（转告用户/换路径），
        // run 不因插件内部失败终局。两类控制流异常保持穿透：GraphInterrupt（W4 人审
        // 挂起——吞掉即审批卡死）；signal.aborted（吞掉则 agent 在中断后继续跑，破坏
        // run.aborted 语义）。审计 failed 行由各插件 execute 内部落，此处不重复。
        if (e instanceof GraphInterrupt || signal.aborted) throw e
        const raw = e instanceof Error ? e.message : String(e)
        const message = raw.length > TOOL_ERROR_MESSAGE_MAX_LEN ? `${raw.slice(0, TOOL_ERROR_MESSAGE_MAX_LEN)}…` : raw
        return [`Tool call failed: ${message}`, undefined]
      }
      const text = contentToText(result.content)
      // responseFormat='content_and_artifact'：二元组 [content, artifact]——content = 模型面，
      // artifact = 渲染面（details）——ToolMessage 据此拆双面，projector tool.end details
      // 取 artifact（R5）。
      return [text, result.details]
    },
    { name: def.name, description: def.description, schema: def.parameters, responseFormat: 'content_and_artifact' },
  )
}

export function toLangChainTools(
  defs: readonly AnyPluginToolDefinition[],
  ctx: PluginToolContext,
  pluginIdOf?: (name: string) => string | undefined,
): ReturnType<typeof toLangChainTool>[] {
  return defs.map((def) => toLangChainTool(def, ctx, pluginIdOf?.(def.name)))
}
