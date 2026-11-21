// #1080 RF-T04 结构化反思块：完整正文渲染（不经 4KiB 工具截断）+ 展示绑定 + 渲染后 ack。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ReflectionBlock from '@/components/chat/ReflectionBlock.vue'
import type { ReflectionDisplay } from '@/api/reflections'

const getReflectionDisplay = vi.fn()
const ackReflectionDisplay = vi.fn()

vi.mock('@/api/reflections', () => ({
  getReflectionDisplay: (...args: unknown[]) => getReflectionDisplay(...args),
  ackReflectionDisplay: (...args: unknown[]) => ackReflectionDisplay(...args),
}))

const presentation = {
  displayId: 'disp-1',
  draftId: 'draft-1',
  version: 2,
  bodyHash: 'a'.repeat(64),
  status: 'pending',
  confirmable: true,
}

function displayWith(overrides: Partial<ReflectionDisplay> = {}): ReflectionDisplay {
  return {
    displayId: 'disp-1',
    draftId: 'draft-1',
    version: 2,
    action: 'create',
    bodyHash: 'a'.repeat(64),
    status: 'active',
    messageId: 'msg-1',
    createdAt: '2026-11-21T00:00:00.000Z',
    categoryLabel: '工具使用',
    confirmable: true,
    body: {
      title: '工具参数验证遗漏',
      category: 'tool_use',
      problem: '长正文：' + '细节'.repeat(3000),
      causes: [{ text: '缺少写后验证', kind: 'fact', evidence: [1] }],
      improvements: ['写文件后先运行聚焦测试'],
      scope: { labels: ['工具使用'], conditions: '涉及写入', exclusions: '纯问答' },
    },
    evidence: [
      { position: 1, sessionId: 's1', messageId: 'm1', region: 'content', start: 0, end: 4, excerpt: '未验证', status: 'valid' },
    ],
    ...overrides,
  }
}

describe('ReflectionBlock', () => {
  beforeEach(() => {
    getReflectionDisplay.mockReset()
    ackReflectionDisplay.mockReset()
    ackReflectionDisplay.mockResolvedValue({ seq: 7, ackedAt: '2026-11-21T00:00:01.000Z' })
    // jsdom 不布局：给已渲染块一个非零高度，模拟“完整渲染完成”。
    Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 120 })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('渲染完整五部分（超过 4KiB 也全文展示）并在渲染后提交 ack', async () => {
    getReflectionDisplay.mockResolvedValue(displayWith())
    const w = mount(ReflectionBlock, { props: { presentation, messageId: 'msg-1' } })
    await flushPromises()

    expect(getReflectionDisplay).toHaveBeenCalledWith('disp-1')
    const body = w.get('[data-test="reflection-body"]')
    expect(body.text()).toContain('工具参数验证遗漏')
    expect(body.text()).toContain('写文件后先运行聚焦测试')
    expect(body.text()).toContain('涉及写入')
    expect(body.text()).toContain('细节细节')
    expect(body.text().length).toBeGreaterThan(4096)
    expect(body.text()).toContain('事实')
    expect(ackReflectionDisplay).toHaveBeenCalledWith('disp-1', { version: 2, hash: 'a'.repeat(64), messageId: 'msg-1' })
  })

  it('证据未核验 → 显示不可确认徽标', async () => {
    getReflectionDisplay.mockResolvedValue(displayWith({
      confirmable: false,
      notConfirmableReason: 'evidence_not_ready',
      evidence: [{ position: 1, sessionId: 's1', messageId: null, region: 'content', start: null, end: null, excerpt: '在飞', status: 'preparing' }],
    }))
    const w = mount(ReflectionBlock, { props: { presentation: { ...presentation, confirmable: false }, messageId: 'msg-1' } })
    await flushPromises()
    expect(w.get('[data-test="reflection-not-confirmable"]').text()).toContain('暂不可确认')
    expect(w.text()).toContain('待持久化')
  })

  it('展示已删除 → 占位文案且不回显正文、不 ack', async () => {
    getReflectionDisplay.mockResolvedValue(displayWith({ body: null, deleted: true, status: 'revoked' }))
    const w = mount(ReflectionBlock, { props: { presentation, messageId: 'msg-1' } })
    await flushPromises()
    expect(w.find('[data-test="reflection-deleted"]').exists()).toBe(true)
    expect(w.find('[data-test="reflection-body"]').exists()).toBe(false)
    expect(ackReflectionDisplay).not.toHaveBeenCalled()
  })

  it('来源失效 → 待复核徽标、占位摘录、不可确认且不 ack（#1084）', async () => {
    getReflectionDisplay.mockResolvedValue(displayWith({
      status: 'revoked',
      invalidated: true,
      confirmable: false,
      notConfirmableReason: 'evidence_changed',
      evidence: [{ position: 1, sessionId: 's1', messageId: 'm1', region: 'content', start: 0, end: 4, excerpt: '[来源已失效，待复核]', status: 'not_ready', reason: 'source_changed' }],
    }))
    const w = mount(ReflectionBlock, { props: { presentation, messageId: 'msg-1' } })
    await flushPromises()
    expect(w.get('[data-test="reflection-invalidated"]').text()).toContain('待复核')
    expect(w.find('[data-test="reflection-not-confirmable"]').exists()).toBe(true)
    expect(w.text()).toContain('[来源已失效，待复核]')
    expect(ackReflectionDisplay).not.toHaveBeenCalled()
  })

  it('消息未绑定（无 messageId）→ 不 ack', async () => {
    getReflectionDisplay.mockResolvedValue(displayWith({ messageId: null }))
    mount(ReflectionBlock, { props: { presentation, messageId: 'msg-1' } })
    await flushPromises()
    expect(ackReflectionDisplay).not.toHaveBeenCalled()
  })
})
