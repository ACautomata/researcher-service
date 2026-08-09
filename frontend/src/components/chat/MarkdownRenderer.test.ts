// seam: components/chat/MarkdownRenderer —— AI 回复 markdown 渲染哑组件（#401 / ticket #402）。
// 组件层 mount 测试（沿用 chatComponents.test.ts 风格）：text → DOM 节点断言；streaming → .cursor。
// 渲染管线不 mock（spec：直接对渲染结果断言，含 sanitize 后结果）。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'

describe('MarkdownRenderer', () => {
  it('#514: 代码块带独立复制操作', () => {
    const w = mount(MarkdownRenderer, { props: { text: '```js\nconst x = 1\n```', streaming: false } })
    expect(w.get('[data-copy-code]').text()).toBe('复制代码')
  })
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

  it('一级到四级标题保持对应语义层级', () => {
    const text = '# 一级\n\n## 二级\n\n### 三级\n\n#### 四级'
    const w = mount(MarkdownRenderer, { props: { text, streaming: false } })
    expect(['h1', 'h2', 'h3', 'h4'].map((tag) => w.get(`.markdown-body ${tag}`).text())).toEqual([
      '一级',
      '二级',
      '三级',
      '四级',
    ])
  })

  it('表格包在消息级横向滚动容器内', () => {
    const table = '| 第一列 | 第二列 |\n| --- | --- |\n| 内容 | 内容 |'
    const w = mount(MarkdownRenderer, { props: { text: table, streaming: false } })
    expect(w.find('.markdown-body .table-scroll > table').exists()).toBe(true)
    expect(w.findAll('.markdown-body .table-scroll').length).toBe(1)
  })

  it('XSS 载荷不进入 DOM（html:false 转义）', () => {
    const w = mount(MarkdownRenderer, { props: { text: '<script>alert(1)</script>', streaming: false } })
    expect(w.find('.markdown-body script').exists()).toBe(false)
    expect(w.text()).toContain('script')
  })

  it('streaming=true → 光标位于最后一个段落内部', () => {
    const w = mount(MarkdownRenderer, { props: { text: '第一段\n\n第二段', streaming: true } })
    const paragraphs = w.findAll('.markdown-body p')
    expect(w.find('.cursor').exists()).toBe(true)
    expect(w.find('.cursor').element.parentElement).toBe(paragraphs.at(-1)?.element)
  })

  it('最后内容是链接时，光标跳出链接但仍留在段落内', () => {
    const w = mount(MarkdownRenderer, {
      props: { text: '参考 [论文](https://example.com)', streaming: true },
    })
    expect(w.find('.markdown-body p > .cursor').exists()).toBe(true)
    expect(w.find('.markdown-body a .cursor').exists()).toBe(false)
  })

  it('最后内容是列表或表格时，光标跟随最后一项内容', () => {
    const list = mount(MarkdownRenderer, { props: { text: '- 一\n- 二', streaming: true } })
    expect(list.findAll('.markdown-body li').at(-1)?.find('.cursor').exists()).toBe(true)

    const table = mount(MarkdownRenderer, {
      props: { text: '| A | B |\n| - | - |\n| 1 | 2 |', streaming: true },
    })
    expect(table.findAll('.markdown-body td').at(-1)?.find('.cursor').exists()).toBe(true)
  })

  it('空流式回答仍渲染光标占位', () => {
    const w = mount(MarkdownRenderer, { props: { text: '', streaming: true } })
    expect(w.find('.markdown-body > .cursor').exists()).toBe(true)
  })

  it('streaming=false → 无光标节点', () => {
    const w = mount(MarkdownRenderer, { props: { text: '完整', streaming: false } })
    expect(w.find('.cursor').exists()).toBe(false)
  })
})
