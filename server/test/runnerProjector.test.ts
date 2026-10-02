import { describe, it, expect } from 'vitest'
import { RunProjector, truncateUtf8 } from '../src/runner/runtime/projector'
import { TOOL_DETAILS_MAX_BYTES, TOOL_INPUT_MAX_BYTES } from '../src/runner/runtime/values'

// S3 纯逻辑（#777 事件桥全接线）：v3 protocol events → 自有 run 域目录事件。
// 事件形态按 #724 PoC 探针实测锁定（deepagents 1.14.1 + langgraph 1.4.18）：
//   {method:'messages', params:{data:{event:'content-block-delta', delta:{type:'text-delta',text}}}}
//   {method:'tools',    params:{data:{event:'tool-started', tool_call_id, tool_name, input}}}
//   {method:'tools',    params:{data:{event:'tool-finished', tool_call_id, output:{kwargs:{status,content,name}}}}}
// 纪律：白名单外一律丢弃（不透传）；投影不抛（畸形按未命中）。

function msgDelta(type: string, fields: Record<string, unknown>) {
  return {
    method: 'messages',
    params: { data: { event: 'content-block-delta', index: 0, delta: { type, ...fields }, run_id: 'r1' } },
  }
}

function toolStarted(id: string, name: string, input: unknown) {
  return {
    method: 'tools',
    params: { data: { event: 'tool-started', tool_call_id: id, tool_name: name, input } },
  }
}

function toolFinished(id: string, status: string, content: unknown, name = 'echo') {
  return {
    method: 'tools',
    params: {
      data: {
        event: 'tool-finished',
        tool_call_id: id,
        output: { kwargs: { status, content, name, tool_call_id: id } },
      },
    },
  }
}

describe('RunProjector：text/thinking 分流（story 1）', () => {
  it('text-delta → text.delta', () => {
    const p = new RunProjector()
    expect(p.feed(msgDelta('text-delta', { text: '你好' }), 0)).toEqual([
      { type: 'text.delta', payload: { delta: '你好' } },
    ])
  })

  it('thinking-delta → thinking.delta 分轨（text/thinking 不串流）', () => {
    const p = new RunProjector()
    expect(p.feed(msgDelta('thinking-delta', { thinking: '嗯……' }), 0)).toEqual([
      { type: 'thinking.delta', payload: { delta: '嗯……' } },
    ])
  })

  it('reasoning-delta 变体宽容收进 thinking 分轨', () => {
    const p = new RunProjector()
    expect(p.feed(msgDelta('reasoning-delta', { reasoning: '推一步' }), 0)).toEqual([
      { type: 'thinking.delta', payload: { delta: '推一步' } },
    ])
  })

  it('空 delta / 未知块类型（input_json_delta 等）→ 丢弃', () => {
    const p = new RunProjector()
    expect(p.feed(msgDelta('text-delta', { text: '' }), 0)).toEqual([])
    expect(p.feed(msgDelta('input_json_delta', { partial_json: '{}' }), 0)).toEqual([])
  })

  it('message-start/finish、content-block-start/finish 不进目录', () => {
    const p = new RunProjector()
    for (const event of ['message-start', 'message-finish', 'content-block-start', 'content-block-finish']) {
      expect(p.feed({ method: 'messages', params: { data: { event } } }, 0)).toEqual([])
    }
  })
})

describe('RunProjector：tool.start / tool.end（story 2）', () => {
  it('tool-started → tool.start{toolCallId,name,input}；tool-finished → tool.end{state,durationMs}', () => {
    const p = new RunProjector()
    expect(p.feed(toolStarted('call_1', 'echo', '{"text":"hi"}'), 1000)).toEqual([
      { type: 'tool.start', payload: { toolCallId: 'call_1', name: 'echo', input: '{"text":"hi"}' } },
    ])
    expect(p.feed(toolFinished('call_1', 'success', 'echo:hi'), 1047)).toEqual([
      {
        type: 'tool.end',
        payload: { toolCallId: 'call_1', name: 'echo', state: 'success', durationMs: 47, details: 'echo:hi' },
      },
    ])
  })

  it('失败工具 status=error → tool.end state=error（durationMs 计时同面）', () => {
    const p = new RunProjector()
    p.feed(toolStarted('call_2', 'execute', '{}'), 100)
    const out = p.feed(toolFinished('call_2', 'error', 'boom', 'execute'), 260)
    expect(out[0]!.type).toBe('tool.end')
    const payload = (out[0]!.payload as { state: string; durationMs: number })
    expect(payload.state).toBe('error')
    expect(payload.durationMs).toBe(160)
  })

  it('成功态 status 缺省（LangChain ToolMessage 语义，实测锁定）→ state=success', () => {
    const p = new RunProjector()
    p.feed(toolStarted('call_s', 'write_file', '{}'), 0)
    const out = p.feed(
      {
        method: 'tools',
        params: {
          data: {
            event: 'tool-finished',
            tool_call_id: 'call_s',
            output: { kwargs: { content: 'ok', tool_call_id: 'call_s', name: 'write_file' } },
          },
        },
      },
      5,
    )
    expect((out[0]!.payload as { state: string }).state).toBe('success')
  })

  it('未见 start 的 finish（理论不可达）durationMs=0 不抛', () => {
    const p = new RunProjector()
    const out = p.feed(toolFinished('call_x', 'success', 'y'), 500)
    expect((out[0]!.payload as { durationMs: number }).durationMs).toBe(0)
  })

  it('details 序列化：非字符串 content 走 JSON', () => {
    const p = new RunProjector()
    p.feed(toolStarted('c', 't', '{}'), 0)
    const out = p.feed(toolFinished('c', 'success', { a: 1 }), 5)
    expect((out[0]!.payload as { details: string }).details).toBe('{"a":1}')
  })
})

describe('RunProjector：截断契约（C 节 ≤4KB details / ≤1k input + 截断标记）', () => {
  it('truncateUtf8 按字节截断且不切残字符', () => {
    const { text, truncated } = truncateUtf8('研'.repeat(10), 10) // 每字 3 字节 → 只容 3 字
    expect(truncated).toBe(true)
    expect(text).toBe('研'.repeat(3))
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(10)
  })

  it('未超限原样返回无标记', () => {
    const { text, truncated } = truncateUtf8('短文本', 1024)
    expect(text).toBe('短文本')
    expect(truncated).toBe(false)
  })

  it('tool.start input >1KB → 截断 + truncated 标记', () => {
    const p = new RunProjector()
    const big = JSON.stringify({ text: '研'.repeat(600) }) // ~1.8KB
    const out = p.feed(toolStarted('c1', 'echo', big), 0)
    const payload = out[0]!.payload as { input: string; truncated?: boolean }
    expect(Buffer.byteLength(payload.input, 'utf8')).toBeLessThanOrEqual(TOOL_INPUT_MAX_BYTES)
    expect(payload.truncated).toBe(true)
  })

  it('tool.end details >4KB → 截断 + truncated 标记', () => {
    const p = new RunProjector()
    p.feed(toolStarted('c2', 'execute', '{}'), 0)
    const big = 'x'.repeat(5000)
    const out = p.feed(toolFinished('c2', 'success', big), 1)
    const payload = out[0]!.payload as { details: string; truncated?: boolean }
    expect(Buffer.byteLength(payload.details, 'utf8')).toBeLessThanOrEqual(TOOL_DETAILS_MAX_BYTES)
    expect(payload.truncated).toBe(true)
    expect(payload.details.length).toBeLessThan(big.length)
  })

  it('恰好边界内无截断标记', () => {
    const p = new RunProjector()
    p.feed(toolStarted('c3', 'echo', 'hi'), 0)
    const out = p.feed(toolFinished('c3', 'success', 'a'.repeat(4096)), 1)
    const payload = out[0]!.payload as { truncated?: boolean }
    expect(payload.truncated).toBeUndefined()
  })
})

describe('RunProjector：不透传与防御（#773 桥纪律）', () => {
  it('非白名单 method（lifecycle/tasks/updates/values/checkpoints）全丢弃', () => {
    const p = new RunProjector()
    for (const method of ['lifecycle', 'tasks', 'updates', 'values', 'checkpoints']) {
      expect(p.feed({ method, params: { data: { event: 'anything' } } }, 0)).toEqual([])
    }
  })

  it('畸形事件（缺 params/缺字段/非对象）不抛全丢弃', () => {
    const p = new RunProjector()
    expect(p.feed(null, 0)).toEqual([])
    expect(p.feed({}, 0)).toEqual([])
    expect(p.feed({ method: 'tools' }, 0)).toEqual([])
    expect(p.feed({ method: 'tools', params: { data: { event: 'tool-started' } } }, 0)).toEqual([])
    expect(p.feed({ method: 'tools', params: { data: { event: 'tool-finished', tool_call_id: 'c' } } }, 0)).toEqual([
      { type: 'tool.end', payload: { toolCallId: 'c', name: '', state: 'success', durationMs: 0, details: '' } },
    ])
  })
})
