// 数学语法补齐（#471 后续）：@vscode/markdown-it-katex 只认 $...$ / $$...$$，
// 而模型常输出 \(...\) / \[...\] 定界符，甚至整段裸 LaTeX。
// 这里在 katex 插件之上补三类入口，统一产出 math_inline / math_block token 复用其渲染器：
//   1. 行内 \( ... \)；
//   2. 独占行的块级 \[ ... \]（可跨行）；
//   3. 整段段落 / 表格单元格就是裸 LaTeX 时自动识别（KaTeX 解析成功才算，代码与散文不受影响）。
import type { MarkdownIt, StateBlock, StateCore, StateInline } from 'markdown-it'
import katex from 'katex'

// 中英混排的说明文字不可能是纯公式；含 CJK 直接排除，避免中文正文误伤。
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const LATEX_COMMAND = /\\[A-Za-z]+/

// 文本类 / 字体类命令的参数是自然语言，判散文前先整体剔除（含 \begin/\end 环境名）。
const TEXTY_COMMAND_ARG =
  /\\(?:text|textrm|textit|textbf|textsf|texttt|textnormal|mbox|mathrm|mathbf|mathit|mathsf|mathtt|mathbb|mathcal|mathfrak|mathscr|bm|operatorname|color|textcolor|begin|end)\s*\{[^{}]*\}/g

/**
 * 判断一段文本是否整体是裸 LaTeX。
 * 双重门槛：去掉命令后不能残留英文散文（≥3 连字母），且 KaTeX 必须能解析——
 * 这样 `\n`、Windows 路径、未定义命令等都会落回普通文本，不会被误渲染。
 */
function isBareLatex(source: string): boolean {
  const text = source.trim()
  if (text.length < 2 || text.length > 4000) return false
  if (CJK.test(text)) return false
  if (!LATEX_COMMAND.test(text)) return false
  const prose = text.replace(TEXTY_COMMAND_ARG, '').replace(/\\[A-Za-z]+/g, '')
  if (/[A-Za-z]{3,}/.test(prose)) return false
  try {
    katex.renderToString(text, { throwOnError: true, displayMode: true, strict: 'ignore' })
    return true
  } catch {
    return false
  }
}

function mathInlineParen(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x5c /* \ */ || state.src[state.pos + 1] !== '(') return false
  const close = state.src.indexOf('\\)', state.pos + 2)
  if (close < 0) return false
  if (!silent) {
    const token = state.push('math_inline', 'math', 0)
    token.markup = '\\('
    token.content = state.src.slice(state.pos + 2, close)
  }
  state.pos = close + 2
  return true
}

function mathBlockBracket(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine]
  if (state.src.slice(start, start + 2) !== '\\[') return false

  let closeLine = -1
  let closePos = -1
  for (let line = startLine; line < endLine; line++) {
    const from = line === startLine ? start + 2 : state.bMarks[line] + state.tShift[line]
    const to = state.eMarks[line]
    const idx = state.src.indexOf('\\]', from)
    if (idx >= 0 && idx + 2 <= to) {
      closeLine = line
      closePos = idx
      break
    }
  }
  if (closeLine < 0) return false
  // 只接管闭合符后无正文的独立公式行，避免吞掉 \[...\] 之后的句子。
  if (state.src.slice(closePos + 2, state.eMarks[closeLine]).trim() !== '') return false
  if (silent) return true

  const token = state.push('math_block', 'math', 0)
  token.block = true
  token.markup = '\\['
  token.content = state.src.slice(start + 2, closePos)
  state.line = closeLine + 1
  return true
}

// 块级解析完成后回看每个 inline token：整段/整格都是裸 LaTeX 才接管。
// 要求 children 只有一个 text token，保证没有强调、链接、行内代码等其它语法参与。
function bareMathCore(state: StateCore): boolean {
  const tokens = state.tokens
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type !== 'inline' || token.children?.length !== 1) continue
    if (token.children[0].type !== 'text' || !isBareLatex(token.content)) continue

    const prev = tokens[i - 1]
    const next = tokens[i + 1]
    if (prev?.type === 'paragraph_open' && next?.type === 'paragraph_close') {
      const math = new state.Token('math_block', 'math', 0)
      math.block = true
      math.markup = '$$'
      math.content = token.content.trim()
      tokens.splice(i - 1, 3, math)
      i -= 2
      continue
    }

    const child = new state.Token('math_inline', 'math', 0)
    child.markup = '$'
    child.content = token.content.trim()
    token.children = [child]
  }
  return true
}

/** 需在 katex 插件之后注册（复用其 math_inline / math_block 渲染器）。 */
export function mathSyntaxPlugin(md: MarkdownIt): void {
  md.inline.ruler.before('escape', 'math_inline_paren', mathInlineParen)
  md.block.ruler.before('paragraph', 'math_block_bracket', mathBlockBracket, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  })
  md.core.ruler.push('bare_math', bareMathCore)
}
