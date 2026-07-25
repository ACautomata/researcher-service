// seam: T08 思考链剥离（issue #44 / spec §8.3 / r26 §4）。
// 覆盖：无标签正文直通、完整 <thinking> 块剥离进 thinking、多块/正文夹杂、流式未闭合（残片截断）、
// 始终无闭合标签保底不丢、replace 快照重解析。
import { describe, expect, it } from 'vitest'
import { splitThinking } from './thinking'

describe('splitThinking (T08 思考链剥离)', () => {
  it('无标签：正文直通，thinking 为空', () => {
    const r = splitThinking('你好，这是回答。')
    expect(r.text).toBe('你好，这是回答。')
    expect(r.thinking).toBe('')
    expect(r.inThinking).toBe(false)
  })

  it('完整 thinking 块：思考进 thinking，正文不含标签', () => {
    const r = splitThinking('<thinking>先分析需求</thinking>答案是 42')
    expect(r.thinking).toBe('先分析需求')
    expect(r.text).toBe('答案是 42')
    expect(r.inThinking).toBe(false)
  })

  it('正文-思考-正文：思考剥离，前后正文拼接', () => {
    const r = splitThinking('前半<thinking>推理</thinking>后半')
    expect(r.text).toBe('前半后半')
    expect(r.thinking).toBe('推理')
    expect(r.inThinking).toBe(false)
  })

  it('多个 thinking 块：全部并入 thinking', () => {
    const r = splitThinking('<thinking>一</thinking>答<thinking>二</thinking>案')
    expect(r.text).toBe('答案')
    expect(r.thinking).toBe('一二')
  })

  it('流式未闭合 thinking：内容暂入 thinking 并标记 inThinking', () => {
    const r = splitThinking('<thinking>还在想')
    expect(r.thinking).toBe('还在想')
    expect(r.text).toBe('')
    expect(r.inThinking).toBe(true)
  })

  it('流式跨帧：第一帧未闭合、第二帧补闭合后归位', () => {
    const a = splitThinking('<thinking>推理中')
    expect(a.inThinking).toBe(true)
    const b = splitThinking('<thinking>推理中</thinking>正文')
    expect(b.inThinking).toBe(false)
    expect(b.thinking).toBe('推理中')
    expect(b.text).toBe('正文')
  })

  it('流式残片：半截 `<thi` 不泄露尖括号到正文', () => {
    const r = splitThinking('回答<thi')
    expect(r.text).toBe('回答')
    expect(r.inThinking).toBe(false)
  })

  it('始终无闭合标签：保底不丢——inThinking 内容仍在 thinking（ finalize 后由 UI 兜底显示）', () => {
    // 网关若中断未发闭合标签，思考内容已入 thinking；正文可空但不报错乱码
    const r = splitThinking('前言<thinking>没闭合的思考')
    expect(r.text).toBe('前言')
    expect(r.thinking).toBe('没闭合的思考')
    expect(r.inThinking).toBe(true)
  })

  it('replace 快照：整段重解析（快照含完整标签）', () => {
    const r = splitThinking('<thinking>想过</thinking>最终正文')
    expect(r.text).toBe('最终正文')
    expect(r.thinking).toBe('想过')
  })

  it('空串 / 仅标签：安全返回', () => {
    expect(splitThinking('').text).toBe('')
    expect(splitThinking('<thinking></thinking>').text).toBe('')
    expect(splitThinking('<thinking></thinking>').thinking).toBe('')
  })
})
