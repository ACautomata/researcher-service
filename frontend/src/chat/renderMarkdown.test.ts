// seam: chat/renderMarkdown —— AI 回复 markdown 渲染纯函数（#401 / ticket #402）。
// 主测试面对 DOM 无依赖（纯函数层）：基本语法 / 半成品容错 / XSS 消毒 / 空文本与中文混排。
// 注：DOMPurify 走 jsdom 兜底（vitest jsdom 环境）；链接 target 经 afterSanitizeAttributes 钩子
// 在消毒出口强制（jsdom 的 DOMPurify 会把 target 当非白名单属性剥掉，钩子里补回）。
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './renderMarkdown'

describe('renderMarkdown 基本语法', () => {
  it('加粗/斜体/行内代码', () => {
    const html = renderMarkdown('**加粗** 与 *斜体* 与 `code`')
    expect(html).toContain('<strong>加粗</strong>')
    expect(html).toContain('<em>斜体</em>')
    expect(html).toContain('<code>code</code>')
  })

  it('代码块围栏 + 语言标签（highlight.js 子集高亮）', () => {
    const html = renderMarkdown('```js\nconst x = 1\n```')
    expect(html).toContain('<pre')
    expect(html).toContain('hljs')
    expect(html).toContain('const')
  })

  it('带语言标签代码块内部含 hljs-* token 高亮类（#403）', () => {
    const html = renderMarkdown('```js\nconst x = 1\n```')
    // 高亮回调注入 span.hljs-keyword / span.hljs-number（pre 上 .hljs 是主题样式钩子）
    expect(html).toContain('<span class="hljs-keyword">const</span>')
    expect(html).toContain('<span class="hljs-number">1</span>')
  })

  it('无语言标签代码块 → 原样文本不高亮（#403）', () => {
    const html = renderMarkdown('```\nconst x = 1\n```')
    expect(html).toContain('<pre')
    expect(html).not.toContain('hljs-keyword') // 无 token 着色，仅转义文本
    expect(html).toContain('const x = 1')
  })

  it('未知语言代码块 → 转义文本不崩', () => {
    const html = renderMarkdown('```definitelynotalang\n<b>raw</b>\n```')
    expect(html).toContain('<pre')
    expect(html).not.toContain('<b>raw</b>') // 源内 HTML 转义，不进入 DOM
    expect(html).toContain('&lt;b&gt;raw&lt;/b&gt;')
  })

  it('无序/有序列表', () => {
    const html = renderMarkdown('- 一\n- 二\n\n1. 甲\n2. 乙')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>一</li>')
    expect(html).toContain('<ol>')
  })

  it('链接：新标签页打开 + noopener', () => {
    const html = renderMarkdown('[链接](https://example.com)')
    expect(html).toContain('<a href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener"')
  })

  it('表格', () => {
    const html = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>a</th>')
    expect(html).toContain('<td>1</td>')
  })

  it('引用块', () => {
    const html = renderMarkdown('> 引述')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('引述')
  })

  it('任务列表（- [ ] / - [x]）', () => {
    const html = renderMarkdown('- [x] 完成\n- [ ] 待办')
    expect(html).toContain('task-list-item')
    expect(html).toContain('checked')
  })

  it('emoji 简写渲染为表情', () => {
    const html = renderMarkdown('加油 :smile:')
    expect(html).not.toContain(':smile:')
    expect(html).toContain('😄')
  })

  it('分隔线', () => {
    const html = renderMarkdown('---')
    expect(html).toContain('<hr>')
  })

  it('标题', () => {
    const html = renderMarkdown('## 二级标题')
    expect(html).toContain('<h2>二级标题</h2>')
  })
})

describe('renderMarkdown 半成品容错（流式中间态）', () => {
  it('未闭合代码块 → 渲染为文本不抛错', () => {
    const html = renderMarkdown('```js\nconst x = 1')
    expect(html).toContain('const')
    expect(html).toContain('1') // 内容仍在（markdown-it 容错为代码块文本），不抛错不丢内容
  })

  it('流式中未闭合带语言标签代码块 → 高亮回调不崩溃（#403）', () => {
    // 半成品经 highlight 回调（ignoreIllegals 不抛错）仍产出 <pre>，内容不丢（spec 用户故事 6：
    // 代码块未闭合时按文本显示不崩溃；markdown-it 容错为代码块文本，这里不 pin token 细节）
    const html = renderMarkdown('```js\nconst x = ')
    expect(html).toContain('<pre')
    expect(html).toContain('x = ') // 尾部内容不丢
  })

  it('未闭合括号/星号 → 文本不崩', () => {
    const html = renderMarkdown('未闭合 **星号 和 (括号')
    expect(html).toContain('未闭合')
    expect(html).toContain('星号')
  })

  it('空文本', () => {
    expect(renderMarkdown('')).toBe('')
  })

  it('纯文本原样输出', () => {
    expect(renderMarkdown('普通文本')).toContain('普通文本')
  })

  it('中文混排', () => {
    const html = renderMarkdown('你好 **世界**，这是 `代码`。')
    expect(html).toContain('<strong>世界</strong>')
    expect(html).toContain('<code>代码</code>')
  })
})

describe('renderMarkdown XSS 消毒', () => {
  it('<script> 标签转义输出', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('<img onerror> 事件属性不执行', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>')
    // html:false 下整段转义为文本——无真实 <img> 元素、无 onerror 属性可触发
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('javascript: 链接剥成纯文本（无 href 不执行）', () => {
    const html = renderMarkdown('[x](javascript:alert(1))')
    expect(html).not.toContain('href')
    expect(html).toContain('[x](') // 退化为文本源码，不产生可点链接
  })

  it('data: 链接被剥成纯文本', () => {
    const html = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)')
    expect(html).not.toContain('href')
  })
})
