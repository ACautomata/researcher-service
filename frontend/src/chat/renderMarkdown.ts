// #401 / ticket #402：AI 回复 markdown 渲染纯函数（对齐 eventTranslate.ts 纯函数先例）。
// 模块级单例 markdown-it（html:false——源内 HTML 标签转义输出，不让它进 DOM）+ emoji/task-lists
// 官方插件 + highlight.js 子集高亮回调；渲染出口过 DOMPurify 强制消毒（全项目首个 v-html 出口，
// 消息内容来自模型输出 + OIDC 用户输入，双侧不可信），链接经消毒钩子统一加 target/rel。
import MarkdownIt from 'markdown-it'
import { full as emojiPlugin } from 'markdown-it-emoji'
import taskListsPlugin from 'markdown-it-task-lists'
import createDOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
// 常用语言子集（全量 ≈ 1MB，R30 §3.2「体积按需考虑」）：js/ts/py/bash/json/xml/css + 常见别名。
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('css', css)

// 单例 markdown-it：模块级装配一次（插件只注册一遍）。
// html:false——源文本里的 HTML 标签转义输出，不让它进 DOM 再等 DOMPurify 捞；
// highlight 回调对已知语言走 hljs 高亮、未知/未闭合代码块退转义文本（流式半成品不崩）。
const md = new MarkdownIt({
  html: false,
  linkify: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`
      } catch {
        // 高亮异常（个别语言在特定输入下抛错）→ 退转义文本，不污染输出
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`
  },
})
md.use(emojiPlugin).use(taskListsPlugin)

// 宽表格使用局部滚动容器，避免撑破消息气泡或把整个消息流变成横向滚动区。
// wrapper 由渲染器生成而非组件运行时改 DOM，流式重渲染与消毒出口保持同一路径。
md.renderer.rules.table_open = () => '<div class="table-scroll"><table>\n'
md.renderer.rules.table_close = () => '</table></div>\n'

// DOMPurify 渲染出口兜底（jsdom/浏览器均可：默认取全局 window，vitest 环境自动回退内部实现）。
// afterSanitizeAttributes 钩子在消毒出口统一强制链接 target="_blank" rel="noopener"
// （用户故事 8：新标签页打开不丢对话位置；jsdom 的 DOMPurify 会剥 target 非白名单属性，钩子补回；
// rel 附加到既有值上避免覆盖任务列表等插件自带的 rel）。
const purify = createDOMPurify()
purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    const rel = node.getAttribute('rel') ?? ''
    node.setAttribute('rel', rel.includes('noopener') ? rel : rel ? `${rel} noopener` : 'noopener')
  }
})

/** 渲染 markdown → 已消毒 HTML（流式期间每帧直接渲染累积半成品，markdown-it 容错为文本）。 */
export function renderMarkdown(text: string): string {
  if (!text) return ''
  return purify.sanitize(md.render(text))
}
