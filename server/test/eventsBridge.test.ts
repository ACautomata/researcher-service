import { describe, it, expect } from 'vitest'
import { projectStreamEvent, buildStreamEventsInvocation } from '../src/events/bridge'

// 接缝 S3（纯逻辑，issue #773）：事件桥薄投影骨架。
// 准据 = #747 C 节 / #726：runner streamEvents 订阅者翻译为自有事件集，**不透传** LangChain
// protocol events（PoC 坑 1：LC 事件形态随版本漂移）；version+configurable 必须同一参数对象
// （PoC 坑 2，resume 时参数不同会静默 no-op 假 done——#747 A 节生产硬约束）。
//
// 测试喂**真实上游形态**（LangChain AIMessageChunk）：chunk.type 恒为消息类型 'ai'，
// reasoning/thinking 走 content 块数组（块类型在块上）——Spec 评审 r3 逮到的死路判据
// （按 chunk.type 判 reasoning 对真实上游永不命中）由此锁定。

// 最小结构化的 LangChain streamEvents 输入形态（langchain 依赖随运行时基座票才引入，
// 桥只依赖结构子集——上游事件多出的字段一律不进投影输出）。
function lcEvent(event: string, data: unknown, extra: Record<string, unknown> = {}) {
  return { event, name: 'model', run_id: 'run-9', data, ...extra }
}

describe('事件桥薄投影：streamEvents → 自有目录', () => {
  it('on_chat_model_stream 字符串 content → text.delta（sessionId/runId 透传自有字段）', () => {
    const out = projectStreamEvent(
      lcEvent('on_chat_model_stream', { chunk: { content: '你好', type: 'ai' } }),
      { sessionId: 'sess-1' },
    )
    expect(out).toEqual([
      { type: 'text.delta', sessionId: 'sess-1', runId: 'run-9', payload: { delta: '你好' } },
    ])
  })

  it('真实形态：thinking 块数组（chunk.type=ai，块类型在块上）→ thinking.delta 分轨', () => {
    const out = projectStreamEvent(
      lcEvent('on_chat_model_stream', {
        chunk: {
          content: [{ type: 'thinking', thinking: '嗯……', signature: 'sig' }],
          type: 'ai',
        },
      }),
      { sessionId: 'sess-1' },
    )
    expect(out).toEqual([
      { type: 'thinking.delta', sessionId: 'sess-1', runId: 'run-9', payload: { delta: '嗯……' } },
    ])
  })

  it('旧形态 reasoning 块（reasoning 字段）同样收（块内容字段随版本漂移，两者兼容）', () => {
    const out = projectStreamEvent(
      lcEvent('on_chat_model_stream', {
        chunk: { content: [{ type: 'reasoning', reasoning: '旧字段' }], type: 'ai' },
      }),
    )
    expect(out).toEqual([
      { type: 'thinking.delta', sessionId: undefined, runId: 'run-9', payload: { delta: '旧字段' } },
    ])
  })

  it('一 chunk 多块逐块翻译（thinking + text 同 chunk → 两事件，保序）', () => {
    const out = projectStreamEvent(
      lcEvent('on_chat_model_stream', {
        chunk: {
          content: [
            { type: 'thinking', thinking: '想一下' },
            { type: 'text', text: '答案' },
          ],
          type: 'ai',
        },
      }),
    )
    expect(out.map((e) => e.type)).toEqual(['thinking.delta', 'text.delta'])
    expect(out[0].payload).toEqual({ delta: '想一下' })
    expect(out[1].payload).toEqual({ delta: '答案' })
  })

  it('白名单外的块跳过：tool_call 块/未知块/无文本 text 块 → 不投影但其余块照出', () => {
    const out = projectStreamEvent(
      lcEvent('on_chat_model_stream', {
        chunk: {
          content: [
            { type: 'tool_call', name: 'fs', args: {} },
            { type: 'image_url', url: 'x' },
            { type: 'text', text: '' },
            { type: 'mystery', foo: 1 },
          ],
          type: 'ai',
        },
      }),
    )
    expect(out).toEqual([])
  })

  it('空/缺失 content → 空数组（骨架不投影，后续票扩展）', () => {
    expect(projectStreamEvent(lcEvent('on_chat_model_stream', { chunk: { content: '' } }))).toEqual([])
    expect(projectStreamEvent(lcEvent('on_chat_model_stream', { chunk: {} }))).toEqual([])
    expect(projectStreamEvent(lcEvent('on_chat_model_stream', {}))).toEqual([])
  })

  it('未知事件类型 → 空数组（不透传：上游目录再大也只在白名单内翻译）', () => {
    expect(projectStreamEvent(lcEvent('on_chain_start', { input: {} }))).toEqual([])
    expect(projectStreamEvent(lcEvent('on_tool_start', { input: {} }))).toEqual([])
    expect(projectStreamEvent(lcEvent('on_chat_model_end', { output: {} }))).toEqual([])
  })

  it('白名单投影：输出只含自有目录字段，LC 专有字段（name/tags/metadata/signature）不外泄', () => {
    const out = projectStreamEvent(
      lcEvent(
        'on_chat_model_stream',
        {
          chunk: {
            content: [{ type: 'thinking', thinking: 'x', signature: 'sig' }],
            lc_kwargs: { secret: 1 },
          },
          tags: ['t'],
          metadata: { m: 1 },
        },
        { parent_ids: ['p1'], metadata: { depth: 2 } },
      ),
      { sessionId: 's' },
    )
    const wire = JSON.stringify(out)
    expect(wire).not.toContain('lc_kwargs')
    expect(wire).not.toContain('parent_ids')
    expect(wire).not.toContain('metadata')
    expect(wire).not.toContain('tags')
    expect(wire).not.toContain('signature')
  })
})

describe('streamEvents 调用参数（PoC 坑 2 锁定）', () => {
  it('version + configurable 同一参数对象，构造一次 resume 复用（version v3：#777 实测修正）', () => {
    const params = buildStreamEventsInvocation('thread-1')
    expect(params.version).toBe('v3')
    expect(params.configurable).toEqual({ thread_id: 'thread-1' })
    // 同一对象引用（非深拷贝等价）——resume/首次调用必须传同一引用语义，
    // 防「重新构造一个相等但不同源的对象」在后续演进中漂移。
    const again = buildStreamEventsInvocation('thread-1')
    expect(again).not.toBe(params)
    expect(again).toEqual(params)
  })

  it('参数对象冻结（调用方不能就地改 configurable）', () => {
    const params = buildStreamEventsInvocation('thread-1')
    expect(Object.isFrozen(params)).toBe(true)
    expect(Object.isFrozen(params.configurable)).toBe(true)
  })
})
