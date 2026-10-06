// #795 S4：同一归约产物承载媒体、就位状态与 figure custom-render。
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { defineComponent } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { applyEvent, attachmentReadiness, fromProjection, newMsg } from './projection'
import type { SessionEvent } from './useEventStream'
import ChatMessageItem from '@/components/chat/ChatMessageItem.vue'
import ToolLine from '@/components/chat/ToolLine.vue'
import { registerPluginWeb, unregisterPluginWeb } from '@/plugins/registry'

afterEach(() => vi.unstubAllGlobals())
const event = (type: string, payload = {}): SessionEvent => ({ type, payload, runId: 'r1' })
const ref = { attachmentId: '123', mime: 'image/png', fileName: 'result.png', size: 12 }
it('媒体块流式终态与回放渲染零差异，字节始终通过下载端点', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('image', { headers: { 'Content-Type': 'image/png', 'Content-Disposition': 'inline' } })))
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:media', revokeObjectURL: vi.fn() })
  const live = [event('run.started'), event('attachment', ref), event('run.completed')].reduce(applyEvent, [])
  const replay = fromProjection({ sessionId: 's1', title: '', messages: [{ id: 'm1', turn: 1, role: 'assistant', content: '', media: [ref], anchorCheckpointId: null, createdAt: '' }] })
  const a = mount(ChatMessageItem, { props: { msg: live[0]! }, global: { plugins: [createPinia()] } })
  const b = mount(ChatMessageItem, { props: { msg: replay[0]! }, global: { plugins: [createPinia()] } })
  await flushPromises()
  expect(a.html()).toBe(b.html())
  expect(a.get('img').attributes('src')).toBe('blob:media')
  a.unmount(); b.unmount()
})
it.each(['success', 'error'])('ingestion %s 的实时与回放就位状态相同', (state) => {
  const user = newMsg('user', '')
  user.media = [ref]; user.sendKey = 'key'
  let live = applyEvent([user], event('run.started'))
  live = applyEvent(live, event('tool.start', { toolCallId: 'ingest-r1', name: 'ingest_attachments', input: '{"attachmentIds":["123"]}' }))
  expect(attachmentReadiness(live, 0)).toBe('pending')
  live = applyEvent(live, event('tool.end', { toolCallId: 'ingest-r1', state }))
  live = applyEvent(live, event('run.completed'))
  const replay = fromProjection({ sessionId: 's1', title: '', messages: [
    { id: 'u', turn: 1, role: 'user', content: '', media: [ref], anchorCheckpointId: null, createdAt: '' },
    { id: 'a', turn: 2, role: 'assistant', content: '', tools: [{ toolCallId: 'ingest-r1', name: 'ingest_attachments', input: '{"attachmentIds":["123"]}', state: state as 'success' | 'error' }], anchorCheckpointId: null, createdAt: '' },
  ] })
  expect(attachmentReadiness(live, 0)).toBe(state === 'success' ? 'ready' : 'error')
  expect(attachmentReadiness(replay, 0)).toBe(attachmentReadiness(live, 0))
})
it('下载引用挂在工具结果；figure 引用由同一归约字段进入 custom-render', () => {
  const definition = { components: { figure: defineComponent({ props: ['details'], template: '<div data-test="figure-ref">{{ details.figureId }}</div>' }) } }
  registerPluginWeb(definition)
  try {
    const figureDetails = '{"figureId":"fig-1","state":"completed","previewReady":true}'
    const events = [event('run.started'), event('tool.start', { toolCallId: 'f1', name: 'figure', input: '{}' }), event('tool.end', { toolCallId: 'f1', state: 'success', details: figureDetails }), event('run.completed')]
    const live = events.reduce(applyEvent, [])
    const replay = fromProjection({ sessionId: 's1', title: '', messages: [{ id: 'm', turn: 1, role: 'assistant', content: '', tools: [{ toolCallId: 'f1', name: 'figure', input: '{}', state: 'success', details: figureDetails }], anchorCheckpointId: null, createdAt: '' }] })
    for (const vm of [live, replay]) {
      const wrapper = mount(ToolLine, { props: { tool: vm[0]!.tools[0]! } })
      expect(wrapper.get('[data-test="figure-ref"]').text()).toBe('fig-1')
      wrapper.unmount()
    }
    const download = mount(ToolLine, { props: { tool: { id: 't1', name: 'write', state: 'done', title: null, input: {}, result: 'written\n[download attachmentId=123 fileName=result data.json mime=application/json size=12]' } } })
    expect(download.get('[data-test="media-file"]').text()).toContain('result data.json')
    expect(download.find('[data-test="media-download"]').exists()).toBe(true)
    download.unmount()
  } finally { unregisterPluginWeb(definition) }
})
