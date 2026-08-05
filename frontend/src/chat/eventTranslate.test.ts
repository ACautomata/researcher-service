// seam: chat/eventTranslate —— ChatEventTranslator 纯函数翻译（#369 M5 前端接线）。
// 移植 backend/chat/tests/test_event_translate.py 契约断言（delta/final/aborted/error/replace 快照/
// final 尾部/tool phase/approval 卡/approvalResolved）。无 I/O 纯函数，直测模块边界。

import { describe, expect, it } from 'vitest'
import { ChatEventTranslator, extractMessageText, type GatewayEventFrame } from './eventTranslate'

function chat(state: string, runId = 'r1', extra: Record<string, unknown> = {}): GatewayEventFrame {
  return { type: 'event', event: 'chat', payload: { runId, state, ...extra } }
}

function agentTool(phase: string, data: Record<string, unknown> = {}): GatewayEventFrame {
  return {
    type: 'event',
    event: 'agent',
    payload: { runId: 'r1', stream: 'tool', data: { phase, ...data } },
  }
}

function approvalRequested(extra: Record<string, unknown> = {}): GatewayEventFrame {
  return { type: 'event', event: 'exec.approval.requested', payload: { id: 'ap-1', kind: 'exec', ...extra } }
}

describe('ChatEventTranslator', () => {
  it('delta(deltaText) → text 增量', () => {
    const t = new ChatEventTranslator()
    expect(t.translate(chat('delta', 'r1', { deltaText: '你好' }))).toEqual([
      { type: 'text', runId: 'r1', delta: '你好' },
    ])
  })

  it('final → done；含未投递尾部先补 text 再 done', () => {
    const t = new ChatEventTranslator()
    t.translate(chat('delta', 'r1', { deltaText: '你好' }))
    expect(t.translate(chat('final', 'r1', { message: '你好世界' }))).toEqual([
      { type: 'text', runId: 'r1', delta: '世界' },
      { type: 'done', runId: 'r1' },
    ])
  })

  it('F9: 非前缀 final（空白规范化）→ 整段 replace 帧 + done（不静默丢权威文本）', () => {
    const t = new ChatEventTranslator()
    // 流式双空格 → final 规范化单空格（message 非 sent 前缀）
    t.translate(chat('delta', 'r1', { deltaText: 'Hello  world' }))
    expect(t.translate(chat('final', 'r1', { message: 'Hello world' }))).toEqual([
      { type: 'text', runId: 'r1', delta: 'Hello world', replace: true },
      { type: 'done', runId: 'r1' },
    ])
  })

  it('F9: 重复 delta 使 sent 翻倍 → final 前缀不匹配 → replace 纠正', () => {
    const t = new ChatEventTranslator()
    t.translate(chat('delta', 'r1', { deltaText: 'abc' }))
    t.translate(chat('delta', 'r1', { deltaText: 'abc' })) // 同内容重复 → sent='abcabc'
    expect(t.translate(chat('final', 'r1', { message: 'abc' }))).toEqual([
      { type: 'text', runId: 'r1', delta: 'abc', replace: true },
      { type: 'done', runId: 'r1' },
    ])
  })

  it('F9: final 与 sent 完全相等 → 仅 done（无漂移不 replace）', () => {
    const t = new ChatEventTranslator()
    t.translate(chat('delta', 'r1', { deltaText: 'ok' }))
    expect(t.translate(chat('final', 'r1', { message: 'ok' }))).toEqual([
      { type: 'done', runId: 'r1' },
    ])
  })

  it('final.message 为 dict{content:[{type:text,text}]} 时从 content[].text 提取（实测校准）', () => {
    const t = new ChatEventTranslator()
    t.translate(chat('delta', 'r1', { deltaText: '你好' }))
    const msg = { role: 'assistant', content: [{ type: 'text', text: '你好世界' }], timestamp: 1785148522491 }
    expect(t.translate(chat('final', 'r1', { message: msg }))).toEqual([
      { type: 'text', runId: 'r1', delta: '世界' },
      { type: 'done', runId: 'r1' },
    ])
  })

  it('delta replace=true + message 快照 → replace 帧（整段替换，前缀/非前缀均正确）', () => {
    const t = new ChatEventTranslator()
    t.translate(chat('delta', 'r1', { deltaText: 'The cat' }))
    expect(t.translate(chat('delta', 'r1', { message: 'The dog', replace: true }))).toEqual([
      { type: 'text', runId: 'r1', delta: 'The dog', replace: true },
    ])
  })

  it('delta replace=true 无快照 → 退回 deltaText 增量', () => {
    const t = new ChatEventTranslator()
    expect(t.translate(chat('delta', 'r1', { deltaText: 'x', replace: true }))).toEqual([
      { type: 'text', runId: 'r1', delta: 'x' },
    ])
  })

  it('final 无 message → 仅 done（不重复发已投递文本）', () => {
    const t = new ChatEventTranslator()
    t.translate(chat('delta', 'r1', { deltaText: '你好' }))
    expect(t.translate(chat('final', 'r1'))).toEqual([{ type: 'done', runId: 'r1' }])
  })

  it('error → error 帧（errorMessage 优先，退 errorKind）', () => {
    const t = new ChatEventTranslator()
    expect(t.translate(chat('error', 'r1', { errorMessage: '模型超时' }))).toEqual([
      { type: 'error', runId: 'r1', message: '模型超时' },
    ])
    expect(t.translate(chat('error', 'r1', { errorKind: 'RATE_LIMIT' }))).toEqual([
      { type: 'error', runId: 'r1', message: 'RATE_LIMIT' },
    ])
  })

  it('aborted → done（视作收尾，非错误）', () => {
    const t = new ChatEventTranslator()
    expect(t.translate(chat('aborted'))).toEqual([{ type: 'done', runId: 'r1' }])
  })

  it('未知 state / 缺 runId / 非 event 帧 / 非 chat 事件 → []', () => {
    const t = new ChatEventTranslator()
    expect(t.translate(chat('streaming'))).toEqual([])
    expect(t.translate({ type: 'event', event: 'chat', payload: { state: 'delta', deltaText: 'x' } })).toEqual([])
    expect(t.translate({ type: 'res', id: 'x', ok: true } as unknown as GatewayEventFrame)).toEqual([])
    expect(t.translate({ type: 'event', event: 'health.changed', payload: {} })).toEqual([])
  })

  it('delta message 变体（非 replace）→ []；replace 无快照无 deltaText → []', () => {
    const t = new ChatEventTranslator()
    expect(t.translate(chat('delta', 'r1', { message: '消息级 delta' }))).toEqual([])
    expect(t.translate(chat('delta', 'r1', { replace: true }))).toEqual([])
  })

  // ---- T06 权限审批 ----
  it('exec.approval.requested → approval 卡（request.command 优先）', () => {
    const t = new ChatEventTranslator()
    const frame = approvalRequested({ request: { command: 'rm -rf /tmp/x', sessionKey: 'sk-1' } })
    expect(t.translate(frame)).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: 'rm -rf /tmp/x', sessionKey: 'sk-1', agentId: null },
    ])
  })

  it('approval 卡 command 取值链：request 缺失退 systemRunPlan.rawCommand → command → 顶层 command', () => {
    const t = new ChatEventTranslator()
    expect(t.translate(approvalRequested({ systemRunPlan: { rawCommand: 'ls -la' } }))).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: 'ls -la', sessionKey: null, agentId: null },
    ])
    expect(t.translate(approvalRequested({ systemRunPlan: { command: 'pwd' } }))).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: 'pwd', sessionKey: null, agentId: null },
    ])
    expect(t.translate(approvalRequested({ command: 'top' }))).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: 'top', sessionKey: null, agentId: null },
    ])
  })

  it('approval 卡 kind 缺省 → 从事件名族派生（plugin.approval.requested → plugin）', () => {
    const t = new ChatEventTranslator()
    const frame = { type: 'event', event: 'plugin.approval.requested', payload: { id: 'ap-2', command: 'x' } }
    expect(t.translate(frame)).toEqual([
      { type: 'approval', id: 'ap-2', kind: 'plugin', command: 'x', sessionKey: null, agentId: null },
    ])
  })

  it('approval 卡缺 id → []（无法 resolve，不出卡）；缺 command 容忍为空', () => {
    const t = new ChatEventTranslator()
    expect(t.translate({ type: 'event', event: 'exec.approval.requested', payload: { kind: 'exec' } })).toEqual([])
    expect(t.translate(approvalRequested({ request: { sessionKey: 'sk' } }))).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: '', sessionKey: 'sk', agentId: null },
    ])
  })

  it('approval 卡 agentId 透传：request.agentId（#394 实测恒下发，string 才取）', () => {
    const t = new ChatEventTranslator()
    expect(t.translate(approvalRequested({ request: { command: 'x', agentId: 'sub-1' } }))).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: 'x', sessionKey: null, agentId: 'sub-1' },
    ])
    // 缺省 → null（主会话审批）；非 string（0 信任防御）→ null
    expect(t.translate(approvalRequested({ request: { command: 'x' } }))).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: 'x', sessionKey: null, agentId: null },
    ])
    expect(t.translate(approvalRequested({ request: { command: 'x', agentId: 42 } }))).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: 'x', sessionKey: null, agentId: null },
    ])
  })

  it('approval 卡 agentId 回退路径：request 缺失时读 systemRunPlan.agentId（host=node 时存在）', () => {
    const t = new ChatEventTranslator()
    expect(t.translate(approvalRequested({ systemRunPlan: { rawCommand: 'ls', agentId: 'sub-2' } }))).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: 'ls', sessionKey: null, agentId: 'sub-2' },
    ])
    // 回退路径同样防御：agentId 缺省/非 string → null
    expect(t.translate(approvalRequested({ systemRunPlan: { rawCommand: 'ls', agentId: false } }))).toEqual([
      { type: 'approval', id: 'ap-1', kind: 'exec', command: 'ls', sessionKey: null, agentId: null },
    ])
  })

  // ---- T08 工具 ----
  it('tool start → running 帧（data.name/toolCallId/args → name/id/input）', () => {
    const t = new ChatEventTranslator()
    expect(t.translate(agentTool('start', { name: 'wiki.search', toolCallId: 'call-1', args: { query: '对比学习' } }))).toEqual([
      { type: 'tool', runId: 'r1', name: 'wiki.search', state: 'running', id: 'call-1', title: null, input: { query: '对比学习' }, result: null, isError: false },
    ])
  })

  it('tool result → done 帧；isError=true → error 帧', () => {
    const t = new ChatEventTranslator()
    expect(t.translate(agentTool('result', { name: 'wiki.search', toolCallId: 'call-2', result: { count: 3 }, isError: false }))).toEqual([
      { type: 'tool', runId: 'r1', name: 'wiki.search', state: 'done', id: 'call-2', title: null, input: null, result: { count: 3 }, isError: false },
    ])
    expect(t.translate(agentTool('result', { name: 'bash', toolCallId: 'call-4', result: { exitCode: 1 }, isError: true }))).toEqual([
      { type: 'tool', runId: 'r1', name: 'bash', state: 'error', id: 'call-4', title: null, input: null, result: { exitCode: 1 }, isError: true },
    ])
  })

  it('tool update → []（跳过中间增量）；非 tool stream → []；缺 runId/name → []', () => {
    const t = new ChatEventTranslator()
    expect(t.translate(agentTool('update', { name: 'bash', toolCallId: 'call-3' }))).toEqual([])
    expect(t.translate({ type: 'event', event: 'agent', payload: { runId: 'r1', stream: 'item', data: { kind: 'command' } } })).toEqual([])
    expect(t.translate({ type: 'event', event: 'agent', payload: { stream: 'tool', data: { phase: 'start' } } })).toEqual([])
    expect(t.translate(agentTool('start'))).toEqual([])
  })

  // ---- approval resolved ----
  it('exec/plugin.approval.resolved → approvalResolved 帧（透传权威 decision，未知值不默认批准）', () => {
    const t = new ChatEventTranslator()
    expect(t.translate({ type: 'event', event: 'plugin.approval.resolved', payload: { id: 'ap-1', decision: 'deny' } })).toEqual([
      { type: 'approvalResolved', id: 'ap-1', decision: 'deny' },
    ])
    expect(t.translate({ type: 'event', event: 'exec.approval.resolved', payload: { id: 'ap-2', decision: 'allow-once' } })).toEqual([
      { type: 'approvalResolved', id: 'ap-2', decision: 'allow-once' },
    ])
    expect(t.translate({ type: 'event', event: 'plugin.approval.resolved', payload: { id: 'ap-1', decision: 'expired' } })[0]).toEqual(
      { type: 'approvalResolved', id: 'ap-1', decision: 'expired' },
    )
    expect(t.translate({ type: 'event', event: 'plugin.approval.resolved', payload: { decision: 'approve' } })).toEqual([])
  })

  it('P2-1: 无 runId 的 chat.error → 连接级错误帧（不静默丢弃，handleError no-runId 分支可达）', () => {
    const t = new ChatEventTranslator()
    // 会话级错误（如「会话不存在」）无 runId——旧实现返回 [] 保证不可见
    expect(
      t.translate({ type: 'event', event: 'chat', payload: { state: 'error', errorMessage: '会话不存在' } }),
    ).toEqual([{ type: 'error', message: '会话不存在' }])
    // run 级错误仍挂 runId（走 runId 过滤）
    expect(
      t.translate({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'error', errorMessage: 'failed' } }),
    ).toEqual([{ type: 'error', runId: 'r1', message: 'failed' }])
  })

  it('P2-2: reset 清空 sent 累积（断线重连边界，防 resume 重放双重追加）', () => {
    const t = new ChatEventTranslator()
    // 流式累积 sent['r1']='abc'
    t.translate({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'delta', deltaText: 'abc' } })
    // 断线重连（生命周期边界）→ reset
    t.reset()
    // 网关 resume 从头重放 delta + final → 不清空会双重追加（sent='abc' 时 final tail 只补 ' def'，
    // 渲染端把重放 delta 再 append → 'abcabc def' 翻倍）；reset 后 final 对空 sent 发完整 'abc def'
    const out = t.translate({ type: 'event', event: 'chat', payload: { runId: 'r1', state: 'final', message: 'abc def' } })
    expect(out).toEqual([
      { type: 'text', runId: 'r1', delta: 'abc def' }, // 完整文本（非 ' def' 尾部残差）
      { type: 'done', runId: 'r1' },
    ])
  })

  it('P2-2: 有界——sent 超上限时全新 run 不增长（终态前断线的 run 不无界泄漏）', () => {
    const t = new ChatEventTranslator()
    // 私有字段（测试同模块访问）；上限 500
    const MAX = (t as unknown as { MAX_SENT_ENTRIES: number }).MAX_SENT_ENTRIES
    for (let i = 0; i < MAX; i++) {
      t.translate({ type: 'event', event: 'chat', payload: { runId: `r${i}`, state: 'delta', deltaText: 'x' } })
    }
    const sent = (t as unknown as { sent: Map<string, string> }).sent
    expect(sent.size).toBe(MAX)
    // 再进全新 run → 不增长
    t.translate({ type: 'event', event: 'chat', payload: { runId: 'overflow', state: 'delta', deltaText: 'x' } })
    expect(sent.size).toBe(MAX)
    expect(sent.has('overflow')).toBe(false)
  })
})

// E1: extractMessageText 是内容提取单一实现（流式 final/delta 与 loadHistory 历史复用）。
// history 消息 content 多态（ADR 0003）：user=string / assistant=数组。
describe('extractMessageText（E1: content 多态，ChatView 历史复用）', () => {
  it('string message 直返', () => {
    expect(extractMessageText('你好')).toBe('你好')
  })
  it('dict content 为 string（user 历史消息）直返', () => {
    expect(extractMessageText({ role: 'user', content: '我的问题' })).toBe('我的问题')
  })
  it('dict content 为数组（assistant 历史）拼 type=text，跳过 thinking', () => {
    expect(
      extractMessageText({
        role: 'assistant',
        content: [{ type: 'thinking', text: '内心' }, { type: 'text', text: '回答' }, { type: 'text', text: '续' }],
      }),
    ).toBe('回答续')
  })
  it('None/空/无 content → 空串（不渲染空泡）', () => {
    expect(extractMessageText(null)).toBe('')
    expect(extractMessageText({ role: 'assistant' })).toBe('')
    expect(extractMessageText({})).toBe('')
  })
})
