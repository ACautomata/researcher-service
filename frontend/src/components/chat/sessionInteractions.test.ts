import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import ToolLine from './ToolLine.vue'
import { applyEvent, fromProjection } from '@/chat/projection'

it('黑名单拒绝即时显示理由，刷新回放仍一致', () => {
  const start = { type: 'tool.start', sessionId: 's', runId: 'r', payload: { toolCallId: 't', name: 'bash', input: '{"command":"rm -rf /"}' } }
  const end = { ...start, type: 'tool.end', payload: { toolCallId: 't', state: 'error', rejection: { source: 'blacklist', reason: '禁止删除根目录' } } }
  const live = applyEvent(applyEvent(applyEvent([], { ...start, type: 'run.started', payload: {} }), start), end)
  const replay = fromProjection({ sessionId: 's', title: '', messages: [{ id: 'm', role: 'assistant', turn: 1, content: '', anchorCheckpointId: 'c', createdAt: '', tools: [{ toolCallId: 't', name: 'bash', input: start.payload.input, state: 'error', rejection: end.payload.rejection }] }] })
  expect(live[0].tools).toEqual(replay[0].tools)
  for (const messages of [live, replay]) {
    const w = mount(ToolLine, { props: { tool: messages[0].tools[0] } })
    expect(w.get('[role="alert"]').text()).toContain('黑名单拦截：禁止删除根目录')
    expect(w.classes()).toContain('error')
  }
})

import RewindDialog from './RewindDialog.vue'

it('恢复确认展示三种范围、完整 exec 跨越清单和文件采样', async () => {
  const w = mount(RewindDialog, { global: { stubs: { teleport: true } }, props: { busy: false, preview: { anchor: 'c', revertOps: 3, pathSample: ['/lab/a'], pathTotal: 2, execCrossed: [{ toolCallId: 'exec-1', input: 'touch /lab/out' }] } } })
  expect(w.text()).toContain('touch /lab/out')
  expect(w.text()).toContain('不会回退')
  expect(w.text()).toContain('/lab/a')
  expect(w.findAll('option').map(o => o.text())).toEqual(['两者同回', '只回对话', '只回文件'])
  await w.get('select').setValue('files')
  await w.get('[data-test="restore-confirm"]').trigger('click')
  expect(w.emitted('confirm')).toEqual([['files']])
})


import ChatMessageItem from './ChatMessageItem.vue'
import { newMsg } from '@/chat/projection'
it('#794 多工具聚合自动展开黑拒，折叠历史轨迹仍红显', () => {
  const msg = newMsg('assistant')
  msg.tools = [
    { id: 'a', name: 'read_file', state: 'done', title: null, input: null, result: null },
    { id: 'b', name: 'bash', state: 'error', title: null, input: null, result: null, rejection: { source: 'blacklist', reason: '危险命令' } },
  ]
  const live = mount(ChatMessageItem, { props: { msg } })
  expect(live.get('[data-test="tool-group"]').attributes()).toHaveProperty('open')
  const replay = mount(ChatMessageItem, { props: { msg: { ...msg, streaming: false, traceFolded: true } } })
  expect(replay.get('[data-test="folded-rejection"]').text()).toContain('危险命令')
})
