// 小语法树校验器：每个 group 汇总重复/备选属性，再验证其量词。
// 这不能替代执行器硬超时（RF-T03），生产在完整门禁前不装配。
export function validHistoryRegex(pattern: string): boolean {
  if ([...pattern].length > 256) return false
  let at = 0
  function expression(group: boolean): { repeat: boolean; alternate: boolean } {
    let repeat = false
    let alternate = false
    while (at < pattern.length && pattern[at] !== ')') {
      const token = pattern[at++]!
      if (token === '|') { alternate = true; continue }
      let atom = { repeat: false, alternate: false }
      let repeatable = true
      if (token === '(') {
        if (pattern[at] === '?') {
          if (pattern.slice(at, at + 2) !== '?:') throw new Error('unsupported group')
          at += 2
        }
        atom = expression(true)
      } else if (token === '\\') {
        const escaped = pattern[at++]
        if (!escaped || /[0-9kg]/.test(escaped)) throw new Error('unsupported escape')
        if (escaped === 'u') {
          if (!/^[0-9a-fA-F]{4}/.test(pattern.slice(at))) throw new Error('unsupported unicode escape')
          at += 4
        } else if (escaped === 'x') {
          if (!/^[0-9a-fA-F]{2}/.test(pattern.slice(at))) throw new Error('invalid hex escape')
          at += 2
        }
        repeatable = escaped !== 'b' && escaped !== 'B'
      } else if (token === '[') {
        let closed = false
        while (at < pattern.length) {
          const char = pattern[at++]
          if (char === '\\') at++
          else if (char === ']') { closed = true; break }
        }
        if (!closed) throw new Error('unclosed class')
      } else if ('*+?{}'.includes(token)) throw new Error('unexpected quantifier')
      else if (token === '^' || token === '$') repeatable = false
      const next = pattern[at]
      if (next && '*+?{'.includes(next)) {
        if (!repeatable || atom.repeat || atom.alternate) throw new Error('nested repeat')
        if (next === '{') {
          const quantifier = /^\{(\d+)(?:,(\d+))?\}/.exec(pattern.slice(at))
          if (!quantifier) throw new Error('unsupported repeat')
          const min = Number(quantifier[1]); const max = Number(quantifier[2] ?? quantifier[1])
          if (min > max || max > 1000) throw new Error('repeat limit')
          at += quantifier[0].length
        } else at++
        // 单层贪婪/惰性量词，禁止第二个重复量词。
        if (pattern[at] === '?') at++
        repeat = true
      }
      repeat ||= atom.repeat
      alternate ||= atom.alternate
    }
    if (group) {
      if (pattern[at++] !== ')') throw new Error('unclosed group')
    }
    return { repeat, alternate }
  }
  try {
    expression(false)
    if (at !== pattern.length) return false
    new RegExp(pattern, 'u')
    return true
  } catch { return false }
}
