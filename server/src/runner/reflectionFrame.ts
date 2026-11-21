// reflections run frame（#1080 · RF-T04）：工具调用与模型输入解引用共享的可信上下文。
//
// 与 historyTool 的 ALS 先例同形：run 身份/owner/当前会话由 RunService 在流外层置位，
// 工具调用与 wrapModelCall 在流内读取；子图 namespace 不继承 Leader 权限。

import { AsyncLocalStorage } from 'node:async_hooks'
import type { PresentationRef, ReflectionContext } from '../reflections/model'

export interface ReflectionRunContext {
  readonly context: ReflectionContext
  readonly signal: AbortSignal
  /** 本轮 present 成功的展示引用：recordTurn 统一接缝写入终态 assistant 消息并绑定展示。 */
  readonly presentations: PresentationRef[]
}

const storage = new AsyncLocalStorage<ReflectionRunContext>()

export function runWithReflectionContext<T>(frame: ReflectionRunContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(frame, fn)
}

export function currentReflectionFrame(): ReflectionRunContext | undefined {
  return storage.getStore()
}

export function reflectionFrameIsLeader(frame: ReflectionRunContext | undefined, checkpointNs: unknown): frame is ReflectionRunContext {
  if (!frame) return false
  // 子图 namespace 含分隔符；即使误传工具句柄也不能继承 Leader 权限。
  return !(typeof checkpointNs === 'string' && checkpointNs.includes('|'))
}
