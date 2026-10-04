// S3 纯逻辑（#779 · #747 C 节「补偿 = 重拉投影 + in-flight 从 checkpoint blob 反序列化重建」）：
// LangGraph checkpoint channel_values.messages → TurnSnapshot（TurnReducer 同形状）。
//
// 两个消费面（单一实现约束——双面零漂移）：
//   story 11  RunService.inFlightProjection（投影 GET 的 inFlight 字段：重连后前端以
//             checkpoint 为锚重建进行中 turn，即焚 token 事件的补偿真相源）
//   story 14  recover run 终态落行（崩溃断点前内容只在 blob——reducer 只有断点后事件，
//             聚合以终态 checkpoint 为准）
//
// 形状对应（PoC S3 验证 blob 自包含 + #779 探针实测）：
//   human  { content: string }                          —— 切片锚（不含进快照：用户消息已在投影 user 行）
//   ai     { content: blocks[], tool_calls?: [...] }     —— text 块→content；thinking 块→thinking；tool_calls→ToolLine(state running)
//   tool   { content: string, tool_call_id, status? }    —— 按 tool_call_id 补 ToolLine 终态 + details
//
// 截断纪律与 TurnReducer 对齐（input≤1k / details≤4KB——双面契约同常量）。
// 已知结构差异（与流式 reducer 对比，记录不补偿）：durationMs 无法从 blob 恢复（缺省不出现）；
// tool input 为 JSON 字符串（流式面为截断后的 args 文本——形状同为 string）。

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { describe, expect, it } from 'vitest'
import { turnFromCheckpointMessages } from '../src/runner/runtime/checkpointTurn'

describe('turnFromCheckpointMessages（S3 · #779 in-flight 重建纯逻辑）', () => {
  it('切片恒「最后一条 human 之后」：调用方约束状态（running/recover 终态）；上一轮终态切出上一轮产出', () => {
    // completed 终态（recover 落行场景）：最后 human 之后 = 本轮完整产出 ✓
    const done = turnFromCheckpointMessages([
      new HumanMessage({ content: '上一问' }),
      new AIMessage({ content: [{ type: 'text', text: '上一答' }] }),
    ])
    expect(done).toEqual({ content: '上一答' })

    // 刚 append human、尚无产出（running 首 super-step 前）→ 空
    const fresh = turnFromCheckpointMessages([
      new HumanMessage({ content: '上一问' }),
      new AIMessage({ content: [{ type: 'text', text: '上一答' }] }),
      new HumanMessage({ content: '新问题' }),
    ])
    expect(fresh).toEqual({ content: '' })
  })

  it('单轮文本：ai text 块 → content（thinking 块 → thinking）', () => {
    const snap = turnFromCheckpointMessages([
      new HumanMessage({ content: 'hi' }),
      new AIMessage({
        content: [
          { type: 'thinking', thinking: '先想一步。' },
          { type: 'text', text: '回答正文。' },
        ],
      }),
    ])
    expect(snap).toEqual({ content: '回答正文。', thinking: '先想一步。' })
  })

  it('工具轮：tool_calls → ToolLine(running)，ToolMessage 按 tool_call_id 补终态 + details', () => {
    const snap = turnFromCheckpointMessages([
      new HumanMessage({ content: '跑个命令' }),
      new AIMessage({
        content: [{ type: 'text', text: '我来执行。' }],
        tool_calls: [{ id: 'call-1', name: 'execute', args: { command: 'echo hi' } }],
      }),
      new ToolMessage({ content: 'hi\nexit 0', tool_call_id: 'call-1' }),
      new AIMessage({ content: [{ type: 'text', text: '执行完成。' }] }),
    ])
    expect(snap.content).toBe('我来执行。执行完成。')
    expect(snap.tools).toEqual([
      { toolCallId: 'call-1', name: 'execute', input: '{"command":"echo hi"}', state: 'success', details: 'hi\nexit 0' },
    ])
  })

  it('未回执的 tool_call → state running（断点恰在工具执行前）', () => {
    const snap = turnFromCheckpointMessages([
      new HumanMessage({ content: 'hi' }),
      new AIMessage({
        content: [{ type: 'text', text: '' }],
        tool_calls: [{ id: 'call-9', name: 'write_file', args: { path: '/lab/a.txt' } }],
      }),
    ])
    expect(snap.tools).toEqual([
      { toolCallId: 'call-9', name: 'write_file', input: '{"path":"/lab/a.txt"}', state: 'running' },
    ])
  })

  it('ToolMessage status=error → state error；content 非 string 防御跳过', () => {
    const snap = turnFromCheckpointMessages([
      new HumanMessage({ content: 'hi' }),
      new AIMessage({ content: [], tool_calls: [{ id: 'c1', name: 'execute', args: {} }] }),
      new ToolMessage({ content: 'boom', tool_call_id: 'c1', status: 'error' }),
    ])
    expect(snap.tools?.[0]).toMatchObject({ toolCallId: 'c1', state: 'error', details: 'boom' })
  })

  it('多工具多轮内容按序拼接；空 human 锚之前的消息不进快照（切片语义）', () => {
    const snap = turnFromCheckpointMessages([
      new HumanMessage({ content: '旧问题' }),
      new AIMessage({ content: [{ type: 'text', text: '旧回答' }] }),
      new HumanMessage({ content: '新问题' }),
      new AIMessage({
        content: [{ type: 'text', text: 'A。' }],
        tool_calls: [{ id: 'c1', name: 'execute', args: {} }],
      }),
      new ToolMessage({ content: 'out', tool_call_id: 'c1' }),
      new AIMessage({
        content: [{ type: 'text', text: 'B。' }],
        tool_calls: [{ id: 'c2', name: 'read_file', args: { path: '/lab/b' } }],
      }),
    ])
    expect(snap.content).toBe('A。B。')
    expect(snap.tools).toEqual([
      { toolCallId: 'c1', name: 'execute', input: '{}', state: 'success', details: 'out' },
      { toolCallId: 'c2', name: 'read_file', input: '{"path":"/lab/b"}', state: 'running' },
    ])
  })

  it('防御面：非 BaseMessage 形状的条目跳过不抛（blob 演进容忍）', () => {
    const mixed: unknown[] = [
      new HumanMessage({ content: 'hi' }),
      { weird: true },
      null,
      new AIMessage({ content: [{ type: 'text', text: 'ok。' }] }),
    ]
    expect(turnFromCheckpointMessages(mixed)).toEqual({ content: 'ok。' })
  })

  it('截断纪律：tool input >1KB、details >4KB 截断 + truncated 标记（TurnReducer 同常量）', () => {
    const bigInput = { path: `/lab/${'x'.repeat(2000)}` }
    const bigDetails = 'd'.repeat(5000)
    const snap = turnFromCheckpointMessages([
      new HumanMessage({ content: 'hi' }),
      new AIMessage({ content: [], tool_calls: [{ id: 'c1', name: 'execute', args: bigInput }] }),
      new ToolMessage({ content: bigDetails, tool_call_id: 'c1' }),
    ])
    expect(snap.tools?.[0]?.truncated).toBe(true)
    expect(snap.tools?.[0]?.input.length).toBeLessThanOrEqual(1024)
    expect(snap.tools?.[0]?.details?.length).toBeLessThanOrEqual(4096)
  })
})
