// #1080 RF-T04（父规格 I5 / RF21）：反思正文只在模型调用边界临时解引用。
// 断言：持久消息只含引用；wrapModelCall 克隆消息后展开完整正文交 handler；原消息不被写回；
// 无 run frame 时不展开；删除的展示不回显旧正文。

import { describe, it, expect } from 'vitest'
import { HumanMessage } from '@langchain/core/messages'
import { createReflectionDereferenceMiddleware } from '../src/runner/reflectionDereference'
import { runWithReflectionContext } from '../src/runner/reflectionFrame'

const LONG_BODY = '【完整反思正文】' + '细节'.repeat(4000)

function requestWith(messages: unknown[]): never {
  return {
    model: {},
    messages,
    systemPrompt: '',
    tools: [],
  } as never
}

describe('#1080 模型输入解引用（RF21）', () => {
  const middleware = createReflectionDereferenceMiddleware({
    displayBodyText: async (_ownerId, displayId) => (displayId === 'disp-1' ? LONG_BODY : null),
    draftBodyText: async (_ownerId, draftId, version) => (draftId === 'draft-1' && version === 3 ? '【草稿正文】' + LONG_BODY : null),
    recordBodyText: async (_ownerId, recordId, version) => (recordId === 'record-1' && version === 2 ? '【记录正文】' + LONG_BODY : null),
  })

  const frame = {
    context: { ownerId: 'u1', currentSessionId: 's1', role: 'leader' as const, runId: 'r1' },
    signal: new AbortController().signal,
    presentations: [],
  }

  it('克隆消息后展开展示正文交给模型，原消息保持引用不变', async () => {
    const original = new HumanMessage('见 reflection_display:disp-1 的完整草稿')
    let received: unknown
    await runWithReflectionContext(frame, async () => {
      await (middleware as unknown as {
        wrapModelCall: (req: unknown, handler: (req: unknown) => unknown) => Promise<unknown>
      }).wrapModelCall(requestWith([original]), (req: unknown) => {
        received = (req as { messages: HumanMessage[] }).messages[0].content
        return { ok: true }
      })
    })
    expect(String(received)).toContain('完整反思正文')
    expect(String(received).length).toBeGreaterThan(8000)
    // 图状态/持久消息侧不写回展开正文。
    expect(original.content).toBe('见 reflection_display:disp-1 的完整草稿')
  })

  it('无 run frame 时不展开', async () => {
    const original = new HumanMessage('reflection_display:disp-1')
    let received: unknown
    await (middleware as unknown as {
      wrapModelCall: (req: unknown, handler: (req: unknown) => unknown) => Promise<unknown>
    }).wrapModelCall(requestWith([original]), (req: unknown) => {
      received = (req as { messages: HumanMessage[] }).messages[0].content
      return { ok: true }
    })
    expect(received).toBe('reflection_display:disp-1')
  })

  it('management read 返回的草稿正文引用同样临时展开，版本不符保留引用', async () => {
    const ok = new HumanMessage('草稿 reflection_draft:draft-1:3')
    const stale = new HumanMessage('草稿 reflection_draft:draft-1:2')
    let received: unknown[] = []
    await runWithReflectionContext(frame, async () => {
      await (middleware as unknown as {
        wrapModelCall: (req: unknown, handler: (req: unknown) => unknown) => Promise<unknown>
      }).wrapModelCall(requestWith([ok, stale]), (req: unknown) => {
        received = (req as { messages: HumanMessage[] }).messages.map((m) => m.content)
        return { ok: true }
      })
    })
    expect(String(received[0])).toContain('草稿正文')
    expect(received[1]).toBe('草稿 reflection_draft:draft-1:2')
  })

  it('正式记录正文引用临时展开，失效/不存在保留引用（#1084）', async () => {
    const ok = new HumanMessage('记录 reflection_record:record-1:2')
    const gone = new HumanMessage('记录 reflection_record:record-9:1')
    let received: unknown[] = []
    await runWithReflectionContext(frame, async () => {
      await (middleware as unknown as {
        wrapModelCall: (req: unknown, handler: (req: unknown) => unknown) => Promise<unknown>
      }).wrapModelCall(requestWith([ok, gone]), (req: unknown) => {
        received = (req as { messages: HumanMessage[] }).messages.map((m) => m.content)
        return { ok: true }
      })
    })
    expect(String(received[0])).toContain('记录正文')
    expect(received[1]).toBe('记录 reflection_record:record-9:1')
  })

  it('展示不可读/已删除 → 保留引用占位，不编造正文', async () => {    const original = new HumanMessage('reflection_display:gone')
    let received: unknown
    await runWithReflectionContext(frame, async () => {
      await (middleware as unknown as {
        wrapModelCall: (req: unknown, handler: (req: unknown) => unknown) => Promise<unknown>
      }).wrapModelCall(requestWith([original]), (req: unknown) => {
        received = (req as { messages: HumanMessage[] }).messages[0].content
        return { ok: true }
      })
    })
    expect(received).toBe('reflection_display:gone')
  })
})
