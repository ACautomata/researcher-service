// seam: components/chat/MarkdownRenderer —— AI 回复 markdown 渲染哑组件（#401 / ticket #402）。
// 组件层 mount 测试（沿用 chatComponents.test.ts 风格）：text → DOM 节点断言；streaming → .cursor。
// 渲染管线不 mock（spec：直接对渲染结果断言，含 sanitize 后结果）。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'

describe('MarkdownRenderer', () => {
  it('text 渲染出对应 DOM 节点（**bold** → strong）', () => {
    const w = mount(MarkdownRenderer, { props: { text: '**bold**', streaming: false } })
    expect(w.find('.markdown-body strong').exists()).toBe(true)
    expect(w.find('.markdown-body strong').text()).toBe('bold')
  })

  it('代码块带语言高亮 class', () => {
    const w = mount(MarkdownRenderer, { props: { text: '```js\nconst x = 1\n```', streaming: false } })
    expect(w.find('.markdown-body pre').exists()).toBe(true)
    expect(w.find('.markdown-body pre.hljs').exists()).toBe(true)
  })

  it('XSS 载荷不进入 DOM（html:false 转义）', () => {
    const w = mount(MarkdownRenderer, { props: { text: '<script>alert(1)</script>', streaming: false } })
    expect(w.find('.markdown-body script').exists()).toBe(false)
    expect(w.text()).toContain('script')
  })

  it('streaming=true → 渲染 .cursor 光标节点', () => {
    const w = mount(MarkdownRenderer, { props: { text: '半成品', streaming: true } })
    expect(w.find('.cursor').exists()).toBe(true)
  })

  it('streaming=false → 无光标节点', () => {
    const w = mount(MarkdownRenderer, { props: { text: '完整', streaming: false } })
    expect(w.find('.cursor').exists()).toBe(false)
  })
})
