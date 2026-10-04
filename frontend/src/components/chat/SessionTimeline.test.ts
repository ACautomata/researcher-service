import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SessionTimeline from './SessionTimeline.vue'

describe('#786 named teammate folds', () => {
  it('keeps the leader timeline separate and reveals teammate history on expansion', async () => {
    const wrapper = mount(SessionTimeline, { props: { projection: {
      sessionId: 'session', title: 'Research',
      messages: [{ id: 'leader-result', turn: 1, role: 'assistant', content: 'Leader synthesis', anchorCheckpointId: null, createdAt: '' }],
      teammates: [{ id: 'reader', name: '文献队友', task: '查文献', status: 'completed',
        messages: [{ id: 'peer-result', turn: 1, role: 'assistant', content: 'Peer evidence', anchorCheckpointId: null, createdAt: '' }],
        mailbox: [{ id: 'mail', senderTeammateId: 'reader', recipientTeammateId: null, kind: 'message', content: 'Useful paper', createdAt: '' }],
      }],
    } } })
    expect(wrapper.get('[data-test="leader-timeline"]').text()).toContain('Leader synthesis')
    expect(wrapper.get('[data-test="leader-timeline"]').text()).not.toContain('Peer evidence')
    expect(wrapper.text()).toContain('文献队友')
    expect(wrapper.text()).not.toContain('Peer evidence')
    await wrapper.get('[data-test="teammate-toggle"]').trigger('click')
    expect(wrapper.text()).toContain('Peer evidence')
    expect(wrapper.text()).toContain('Useful paper')
    expect(wrapper.get('[data-test="teammate-toggle"]').attributes('aria-expanded')).toBe('true')
  })
})
