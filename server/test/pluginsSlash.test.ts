// #952 T1·prefactor：系统命令设施（SYSTEM_COMMANDS/parseSlash）自原官方内容目录模块
// 迁出至 plugins/slash.ts（#938 Q3 拍板落点）后的公共接口规格——搬家语义零变化（D51 硬约束）。
import { describe, expect, it } from 'vitest'
import { parseSlash, SYSTEM_COMMANDS } from '../src/plugins/slash'

describe('#952 系统命令设施（plugins/slash）', () => {
  it('系统命令恰为 /new /compact /model 三值', () => {
    expect([...SYSTEM_COMMANDS]).toEqual(['new', 'compact', 'model'])
  })

  it('解析无参斜杠命令：args 为空串', () => {
    expect(parseSlash('/new')).toEqual({ name: 'new', args: '' })
  })

  it('解析带参斜杠命令：name 取首段、args 取余下全文', () => {
    expect(parseSlash('/model sonnet-5')).toEqual({ name: 'model', args: 'sonnet-5' })
  })

  it('args 首尾空白裁剪，内部（含换行）保留', () => {
    expect(parseSlash('/compact   压缩这段  ')).toEqual({ name: 'compact', args: '压缩这段' })
    expect(parseSlash('/new 第一行\n第二行')).toEqual({ name: 'new', args: '第一行\n第二行' })
  })

  it('非斜杠文本不解析', () => {
    expect(parseSlash('new')).toBeUndefined()
    expect(parseSlash('')).toBeUndefined()
  })

  it('命令名须以小写字母开头（数字/符号开头不解析）', () => {
    expect(parseSlash('/9bad')).toBeUndefined()
    expect(parseSlash('/-bad')).toBeUndefined()
  })
})
