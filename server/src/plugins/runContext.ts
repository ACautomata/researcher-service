// 插件 run frame（#792 · #744 §11.1「run 装配注入」）：run 执行体外层置位的 per-run
// 上下文——agent 自动调用路径的 ctx 四件解析源。图实例跨 run 复用（图缓存），ctx 四件
// 不能构造期绑定 run 身份——ALS 运行期读取是唯一非侵入通道（approval funnel / journaling
// 的 runtime 读取面同一纪律）。
//
// {execute} 直达路径不经 ALS：RunService 显式构造四件后直接传入 exec（同一 frame 构造面）。
// frame 缺失（注册期探针/无 runner 上下文）→ ctx 四件 undefined，域工具执行时自校验。

import { AsyncLocalStorage } from 'node:async_hooks'
import type { PluginAuditPort, PluginFiguresPort, PluginLlmPort, PluginRunIdentity, PluginToolContext } from './api'

export interface PluginRunFrame {
  readonly run: PluginRunIdentity
  readonly figures: PluginFiguresPort
  readonly llm: PluginLlmPort
  readonly audit: PluginAuditPort
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

// frame → execute exec 面件（ctx 四件展开 + onUpdate 单参包装）——agent 路径（tools.ts
// ALS 解析）与 {execute} 直达路径（RunService 显式构造）的单一共享实现。frame 缺省 =
// ctx 最小面（config/logger）+ 无 onUpdate，域工具自校验明确报错。
export function execPartsFromFrame(
  ctx: PluginToolContext,
  frame: PluginRunFrame | undefined,
  toolCallId: string,
): { readonly ctx: PluginToolContext; readonly onUpdate?: (partial: unknown) => void } {
  if (!frame) return { ctx }
  return {
    ctx: { ...ctx, run: frame.run, figures: frame.figures, llm: frame.llm, audit: frame.audit },
    onUpdate: (partial: unknown) => frame.onUpdate(toolCallId, partial),
  }
}
