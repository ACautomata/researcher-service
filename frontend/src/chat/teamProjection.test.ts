import { expect, it } from 'vitest'
import { applySessionEvent, reconcileSessionProjection } from './teamProjection'
import type { SessionProjection } from '@/api/sessions'
it('repairs missed thinking, tools and attachments while preserving newer text', () => {
  const current: SessionProjection = { sessionId: 's', title: '', messages: [], inFlight: { runId: 'r', state: 'running', turn: { content: 'new text', tools: [{ toolCallId: 't', name: 'execute', input: '', state: 'running' }] } } }
  const incoming: SessionProjection = { ...current, inFlight: { runId: 'r', state: 'running', turn: { content: 'new', thinking: 'recovered', tools: [{ toolCallId: 't', name: 'execute', input: '', state: 'success', details: 'done' }], media: [{ attachmentId: 'a', fileName: 'a.json', mime: 'application/json', size: 2 }] } } }
  const result = reconcileSessionProjection(current, incoming)
  expect(result.inFlight?.turn).toMatchObject({ content: 'new text', thinking: 'recovered', tools: [{ state: 'success', details: 'done' }], media: [{ attachmentId: 'a' }] })
  expect(applySessionEvent(result, { type: 'text.delta', sessionId: 's', payload: { delta: '!' } }).inFlight?.turn.content).toBe('new text!')
  expect(reconcileSessionProjection(result, { sessionId: 's', title: '', messages: [] }).inFlight).toBeUndefined()
})
