// seam: chat/sessionProjection —— #560 SDK SessionProjection 减负的真实归约器适配（gatewayChat 注入）。
// 直测真实 SDK（createSessionProjection/reduceSessionProjectionRunEvent/hasSessionProjectionAcceptedFinal）
// 经适配器的行为：payload 直喂归约、终态 message 归一、重放去重、timeout/yielded 细分、reset 重建。
// 无 I/O 纯逻辑，直测模块边界（与 gatewayChat.test.ts 的接线测试互补——那里断言 frame 路由）。

import { describe, expect, it } from 'vitest'
import { SessionProjectionReducerAdapter } from './sessionProjection'
import type { GatewayEventFrame } from './eventTranslate'

function chat(state: string, runId: string, extra: Record<string, unknown> = {}) {
  return { type: 'event', event: 'chat', payload: { runId, state, ...extra } } as GatewayEventFrame
}

describe('SessionProjectionReducerAdapter（#560 SDK 归约器适配）', () => {
  it('delta → 归约（projection 更新）；返回 currentRun.status=streaming（渲染仍走手写增量路径）', () => {
    const r = new SessionProjectionReducerAdapter()
    const t = r.reduce(chat('delta', 'r1', { deltaText: 'Hi' }))
    expect(t?.currentRun.status).toBe('streaming')
    expect(t?.isReplayedFinal).toBe(false)
  })

  it('final → currentRun.status=completed + currentRun.message 归一（SDK updateRun 保留逻辑）', () => {
    const r = new SessionProjectionReducerAdapter()
    r.reduce(chat('delta', 'r1', { deltaText: 'Hi' }))
    const t = r.reduce(chat('final', 'r1', { message: 'Hello world' }))
    expect(t?.currentRun.status).toBe('completed')
    expect(t?.currentRun.message).toBe('Hello world')
    // final 无 message → 沿用 delta 期快照（SDK 保留 current.message 逻辑）
    const t2 = r.reduce(chat('final', 'r2', { message: 'X' }))
    const t3 = r.reduce(chat('final', 'r2', {}))
    expect(t2?.currentRun.status).toBe('completed')
    expect(t3?.currentRun.message).toBe('X')
  })

  it('error → status=error；errorMessage 经 readNonemptyString 归一（trim 空 → undefined）', () => {
    const r = new SessionProjectionReducerAdapter()
    const t = r.reduce(chat('error', 'r1', { errorMessage: '  boom  ', errorKind: 'RATE_LIMIT' }))
    expect(t?.currentRun.status).toBe('error')
    expect(t?.currentRun.errorMessage).toBe('boom')
    const t2 = r.reduce(chat('error', 'r2', { errorMessage: '   ', errorKind: 'X' }))
    expect(t2?.currentRun.errorMessage).toBeUndefined()
  })

  it('review L2: 空白 errorMessage → currentRun.errorKind 兜底（翻译层回退链的源头数据）', () => {
    const r = new SessionProjectionReducerAdapter()
    const t = r.reduce(chat('error', 'r1', { errorMessage: '   ', errorKind: 'RATE_LIMIT' }))
    expect(t?.currentRun.errorMessage).toBeUndefined() // trim 空 → undefined（readNonemptyString）
    expect(t?.currentRun.errorKind).toBe('RATE_LIMIT') // errorKind 同样归一后保留
  })

  it('error + errorKind=timeout → status=timeout 细分（此前无此区分）', () => {
    const r = new SessionProjectionReducerAdapter()
    const t = r.reduce(chat('error', 'r1', { errorKind: 'timeout' }))
    expect(t?.currentRun.status).toBe('timeout')
  })

  it('final + yielded=true + stopReason=end_turn → status=yielded 细分', () => {
    const r = new SessionProjectionReducerAdapter()
    const t = r.reduce(chat('final', 'r1', { message: 'go', yielded: true, stopReason: 'end_turn' }))
    expect(t?.currentRun.status).toBe('yielded')
    // yielded 但 stopReason 非 end_turn → completed（SDK 语义）
    const t2 = r.reduce(chat('final', 'r2', { message: 'go', yielded: true, stopReason: 'tool' }))
    expect(t2?.currentRun.status).toBe('completed')
  })

  it('final + stopReason=error → status=error（SDK 归约，非 completed）', () => {
    const r = new SessionProjectionReducerAdapter()
    const t = r.reduce(chat('final', 'r1', { message: 'x', stopReason: 'error' }))
    expect(t?.currentRun.status).toBe('error')
  })

  it('aborted → status=aborted', () => {
    const r = new SessionProjectionReducerAdapter()
    const t = r.reduce(chat('aborted', 'r1'))
    expect(t?.currentRun.status).toBe('aborted')
  })

  it('重放去重：同一 run 的 final 重复到达（有 id identity）→ 第二次 isReplayedFinal=true', () => {
    const r = new SessionProjectionReducerAdapter()
    const finalMsg = {
      role: 'assistant',
      content: [{ type: 'text', text: 'A' }],
      __openclaw: { id: 'msg-1', role: 'assistant', seq: 5 },
    }
    r.reduce(chat('delta', 'r1', { deltaText: 'A' }))
    const first = r.reduce(chat('final', 'r1', { message: finalMsg }))
    expect(first?.isReplayedFinal).toBe(false) // 首次终态：previousRun=streaming，不判重放
    const second = r.reduce(chat('final', 'r1', { message: finalMsg }))
    expect(second?.isReplayedFinal).toBe(true) // 重放：previousRun 已终态 + identity 命中
  })

  it('首次终态（previousRun=streaming）恒不判重放——避免同内容快照指纹误判（规格 §2.6）', () => {
    const r = new SessionProjectionReducerAdapter()
    // 无 id/seq 的普通消息：identity 退化为内容指纹；首次终态时 previousRun=streaming（message 是
    // delta 快照），若用指纹判定会误判重放——适配器只在 previousRun 已终态时启用去重网。
    r.reduce(chat('delta', 'r1', { deltaText: '同样内容' }))
    const first = r.reduce(chat('final', 'r1', { message: '同样内容' }))
    expect(first?.isReplayedFinal).toBe(false) // 不被指纹误判
  })

  it('reset 重建 projection（onHello 生命周期边界）——旧 run 终态身份作废', () => {
    const r = new SessionProjectionReducerAdapter()
    const finalMsg = {
      role: 'assistant',
      content: [{ type: 'text', text: 'A' }],
      __openclaw: { id: 'msg-1', role: 'assistant', seq: 5 },
    }
    r.reduce(chat('final', 'r1', { message: finalMsg }))
    const replayed = r.reduce(chat('final', 'r1', { message: finalMsg }))
    expect(replayed?.isReplayedFinal).toBe(true)
    r.reset()
    const afterReset = r.reduce(chat('final', 'r1', { message: finalMsg }))
    expect(afterReset?.isReplayedFinal).toBe(false) // 新连接：同 runId 重新渲染
  })

  it('非 chat 事件 / 非法 state / 无 runId → null（归约器不消费，照旧按 payload 路径处理）', () => {
    const r = new SessionProjectionReducerAdapter()
    expect(r.reduce({ type: 'event', event: 'agent', payload: { runId: 'r1', stream: 'tool' } })).toBeNull()
    expect(r.reduce({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'streaming' } })).toBeNull()
    expect(r.reduce({ type: 'event', event: 'chat', payload: { state: 'error', errorMessage: '会话级' } })).toBeNull()
    expect(r.reduce({ type: 'res', id: 'x' } as unknown as GatewayEventFrame)).toBeNull()
  })
})
