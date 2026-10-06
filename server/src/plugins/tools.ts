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
//   - ctx 四件 / onUpdate 从 plugin run frame（ALS）解析——图实例跨 run 复用，run 身份
//     只能运行期读取（runContext.ts 头注）。frame 缺失 = ctx 最小面（config/logger），
//     域工具自校验明确报错。

import { randomUUID } from 'node:crypto'
import { tool } from '@langchain/core/tools'
import type { AnyPluginToolDefinition, PluginToolContentBlock, PluginToolContext } from './api'
import { currentPluginRunFrame, execPartsFromFrame } from './runContext'
import { currentToolCallContext } from '../runner/filejournal/context'

export function contentToText(content: readonly PluginToolContentBlock[]): string {
  return content
    .map((block) => (block.type === 'text' ? block.text : `[image: ${block.image_url.url}]`))
    .join('\n')
}

export function toLangChainTool(def: AnyPluginToolDefinition, ctx: PluginToolContext) {
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
      const result = await def.execute(toolCallId, params as never, {
        signal,
        ...execPartsFromFrame(ctx, currentPluginRunFrame(), toolCallId),
      })
      const text = contentToText(result.content)
      // responseFormat='content_and_artifact'：二元组 [content, artifact]——content = 模型面，
      // artifact = 渲染面（details）——ToolMessage 据此拆双面，projector tool.end details
      // 取 artifact（R5）。
      return [text, result.details]
    },
    { name: def.name, description: def.description, schema: def.parameters, responseFormat: 'content_and_artifact' },
  )
}

export function toLangChainTools(defs: readonly AnyPluginToolDefinition[], ctx: PluginToolContext): ReturnType<typeof toLangChainTool>[] {
  return defs.map((def) => toLangChainTool(def, ctx))
}
