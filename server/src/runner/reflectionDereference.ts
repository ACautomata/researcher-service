// 模型输入解引用适配（#1080 · RF-T04 · 父规格 I5/RF21）。
//
// 持久 ToolMessage / checkpoint / 消息聚合只保存展示引用（reflection_display:<id>）；每次
// invoke/stream 前克隆本次请求的消息，按引用临时展开完整正文，仅替换该次调用入参。
// 绝不调用 state reducer/updateState 写回图状态——展开正文不进入 checkpoint。

import { createMiddleware } from 'langchain'
import type { BaseMessage } from '@langchain/core/messages'
import { REFLECTION_BODY_REF_RE, REFLECTION_DRAFT_REF_RE, REFLECTION_RECORD_REF_RE } from '../reflections/values'
import type { ReflectionService } from '../reflections/service'
import { currentReflectionFrame } from './reflectionFrame'

type Dereference = Pick<ReflectionService, 'displayBodyText' | 'draftBodyText' | 'recordBodyText'>

function expandString(text: string, bodies: ReadonlyMap<string, string>): string {
  return text
    .replace(REFLECTION_BODY_REF_RE, (match, id: string) => bodies.get(`display:${id}`) ?? match)
    .replace(REFLECTION_DRAFT_REF_RE, (match, id: string, version: string) => bodies.get(`draft:${id}:${version}`) ?? match)
    .replace(REFLECTION_RECORD_REF_RE, (match, id: string, version: string) => bodies.get(`record:${id}:${version}`) ?? match)
}

function expandContent(content: unknown, bodies: ReadonlyMap<string, string>): unknown {
  if (typeof content === 'string') return expandString(content, bodies)
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
        return { ...(block as object), text: expandString((block as { text: string }).text, bodies) }
      }
      return block
    })
  }
  return content
}

// 克隆消息但保留原型（LangChain 消息的 _getType 等方法在原型上；浅展开字段不写回原对象）。
function cloneMessage(m: BaseMessage, bodies: ReadonlyMap<string, string>): BaseMessage {
  const clone = Object.assign(Object.create(Object.getPrototypeOf(m)), m) as BaseMessage & { content: unknown }
  clone.content = expandContent(m.content, bodies) as BaseMessage['content']
  return clone as BaseMessage
}

function messageTexts(message: BaseMessage): string[] {
  const texts: string[] = []
  if (typeof message.content === 'string') texts.push(message.content)
  else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      const b = block as { type?: unknown; text?: unknown }
      if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    }
  }
  return texts
}

async function collectBodies(messages: readonly BaseMessage[], dereference: Dereference): Promise<Map<string, string>> {
  const frame = currentReflectionFrame()
  const bodies = new Map<string, string>()
  if (!frame) return bodies
  for (const message of messages) {
    for (const text of messageTexts(message)) {
      for (const match of text.matchAll(REFLECTION_BODY_REF_RE)) {
        const key = `display:${match[1]}`
        if (bodies.has(key)) continue
        const body = await dereference.displayBodyText(frame.context.ownerId, match[1])
        // 删除/不可读的展示保留引用占位（不回显缓存正文）。
        if (body !== null) bodies.set(key, body)
      }
      for (const match of text.matchAll(REFLECTION_DRAFT_REF_RE)) {
        const key = `draft:${match[1]}:${match[2]}`
        if (bodies.has(key)) continue
        // 草稿正文同样只展开本轮 management read 实际返回的引用。
        if (!frame.authorizedDrafts.has(`${match[1]}:${match[2]}`)) continue
        const body = await dereference.draftBodyText(frame.context.ownerId, match[1], Number(match[2]))
        if (body !== null) bodies.set(key, body)
      }
      for (const match of text.matchAll(REFLECTION_RECORD_REF_RE)) {
        const key = `record:${match[1]}:${match[2]}`
        if (bodies.has(key)) continue
        // 只有本轮 read 实际授权过的记录引用才展开；模型自填的引用保持占位。
        if (!frame.authorizedRecords.has(`${match[1]}:${match[2]}`)) continue
        const body = await dereference.recordBodyText(frame.context, match[1], Number(match[2]))
        if (body !== null) bodies.set(key, body)
      }
    }
  }
  return bodies
}

export function createReflectionDereferenceMiddleware(dereference: Dereference) {
  return createMiddleware({
    name: 'reflection-input-dereference',
    wrapModelCall: async (request, handler) => {
      if (!currentReflectionFrame()) return handler(request)
      const bodies = await collectBodies(request.messages, dereference)
      if (bodies.size === 0) return handler(request)
      const messages = request.messages.map((m) => cloneMessage(m, bodies))
      return handler({ ...request, messages })
    },
  })
}
