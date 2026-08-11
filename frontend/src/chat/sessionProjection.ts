// #560: SDK SessionProjection 减负——真实归约器实现（gatewayChat 注入 eventTranslate）。
// SDK `@openclaw/gateway-client/browser` 已导出的 SessionProjection 套件（createSessionProjection /
// reduceSessionProjectionRunEvent / hasSessionProjectionAcceptedFinal）接管：
//   - run 终态归一化（currentRun.status：aborted/completed/error/timeout/yielded）
//   - 终态消息归一化（payload.message → currentRun.message，errorMessage 已 readNonemptyString 归一）
//   - 重放去重（hasSessionProjectionAcceptedFinal：上次已接受过的终态 final 重复到达 → 跳过渲染）
// 归约器只消费 chat run 事件（delta/final/aborted/error）；审批/工具等其它事件不经此（归约器
// 不解析 content[]，delta 渲染翻译仍 100% 自建——#553 结论）。
// 生命周期 = 连接：onHello 重建 projection（不跨连接维护，重连后 transcript 走全量 loadHistory）。

import {
  createSessionProjection,
  reduceSessionProjectionRunEvent,
  hasSessionProjectionAcceptedFinal,
  type SessionProjectionState,
  type SessionProjectionRun as SdkSessionProjectionRun,
} from '@openclaw/gateway-client/browser'
import type {
  GatewayEventFrame,
  SessionProjectionReducer,
  SessionProjectionRun,
  SessionProjectionRunTransition,
} from './eventTranslate'

const CHAT_RUN_STATES = new Set(['delta', 'final', 'aborted', 'error'])

// SDK 归约器只做「run 终态归一化 + 终态消息归一化 + 重放去重」三件事的窄化适配：输入是 chat 事件
// payload（与 SessionProjectionGatewayRunEvent 同构，直接喂入）；输出是翻译层需要的判定结果。
export class SessionProjectionReducerAdapter implements SessionProjectionReducer {
  private projection: SessionProjectionState

  constructor() {
    // 惰性创建语义：首个 chat run 事件时归约（reduceSessionProjectionRunEvent 对空 projection 工作）。
    this.projection = createSessionProjection()
  }

  reduce(event: GatewayEventFrame): SessionProjectionRunTransition | null {
    if (event.type !== 'event' || event.event !== 'chat') return null
    const payload = event.payload && typeof event.payload === 'object' ? (event.payload as Record<string, unknown>) : {}
    const state = payload.state
    if (typeof state !== 'string' || !CHAT_RUN_STATES.has(state)) return null
    const runId = typeof payload.runId === 'string' ? payload.runId : ''
    if (!runId) return null // 无 runId（连接级 error 等）：不归约，照旧按 payload 路径处理
    const transition = reduceSessionProjectionRunEvent(this.projection, payload)
    if (!transition || !transition.currentRun) return null
    this.projection = transition.projection
    const current = toProjectionRun(transition.currentRun)
    // 重放去重网**只服务 final 事件**（规格 §2.4/§2.6：SDK acceptedFinalMessageIdentities 只在
    // completed/yielded 记终态身份，error/aborted 身份恒空、consult 该网无意义且带 message 时可能
    // 指纹误判吞帧——翻译层对 error/aborted 不 consult isReplayedFinal，此处仅计算 final 兜底语义）。
    // 首次 final 时 previousRun 为 streaming（message 是 delta 快照），SDK 对无 id/seq 的消息退化
    // 为内容指纹判定，同内容快照会被误判——故仅当 previousRun 已终态（本终态是重复到达）才判定。
    const isReplayedFinal =
      state === 'final' &&
      transition.previousRun !== undefined &&
      transition.previousRun.status !== 'streaming' &&
      hasSessionProjectionAcceptedFinal(transition.previousRun, payload.message)
    return { currentRun: current, isReplayedFinal }
  }

  reset(): void {
    this.projection = createSessionProjection()
  }
}

// SDK SessionProjectionRun → 翻译层窄化 Run（去掉渲染不需要的字段，防下层依赖 SDK 内部形状）。
function toProjectionRun(run: SdkSessionProjectionRun): SessionProjectionRun {
  return {
    runId: run.runId,
    status: run.status,
    ...(run.message !== undefined ? { message: run.message } : {}),
    ...(run.errorMessage !== undefined ? { errorMessage: run.errorMessage } : {}),
    ...(run.errorKind !== undefined ? { errorKind: run.errorKind } : {}),
  }
}
