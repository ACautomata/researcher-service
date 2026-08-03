// wiki path 请求层校验单测（#335 · paths.ts）。补 codex PR#346 P2：路径长度须按 Unicode code points
// 计（Django CharField(max_length=512) 契约），非 UTF-16 code units——含 emoji 等非 BMP 字符的合法
// 路径不得被误拒 90002。

import { describe, it, expect } from 'vitest'
import { normalizeRelPath } from '../src/wiki/paths'

describe('normalizeRelPath 路径长度（Unicode code points，codex PR#346）', () => {
  it('含 emoji 等多字节字符：按 code points 计（≤512 有效，即便 code units >512）', () => {
    const seg = 'x😀' // 2 code points / 3 code units
    const deep = Array.from({ length: 150 }, () => seg).join('/')
    // 150 段：code points = 3*150+4 = 454 ≤ 512；code units = 4*150+4 = 604 > 512（旧实现误拒）
    const ok = normalizeRelPath(`${deep}/a.md`)
    expect(ok).toEqual({ ok: true, path: `${deep}/a.md` })
  })

  it('超过 512 code points 仍拒 90002', () => {
    const seg = 'x😀'
    const deep = Array.from({ length: 300 }, () => seg).join('/') // 3*300+4 = 904 code points
    const res = normalizeRelPath(`${deep}/a.md`)
    expect(res).toEqual({ ok: false, errors: ['path 过长'] })
  })

  it('纯 ASCII 边界：512 恰好有效、513 拒', () => {
    expect(normalizeRelPath(`${'a'.repeat(509)}.md`).ok).toBe(true) // 509+3=512
    expect(normalizeRelPath(`${'a'.repeat(510)}.md`)).toEqual({ ok: false, errors: ['path 过长'] }) // 513
  })
})
