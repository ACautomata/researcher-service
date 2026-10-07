// files path 请求层校验单测（#589 · paths.ts；T0 #801 只读化收缩后形状）。
// 覆盖 #586 US10 穿越防护矩阵：绝对路径/反斜杠/`..`/NUL/超长（Unicode code points 计长）/
// 归一化折叠/空串=树根；root 三态（lab 现役 / wiki+workspace 退役→调用方转 60042）。
// T0 删除的 parseFileWriteBody/requireWritableFileRoot/resolveWorkspaceAbsPath 随写面退役。

import { describe, it, expect } from 'vitest'
import { normalizeFilePath, normalizeFileRoot, requireFilePath, requireFileRoot } from '../src/files/paths'
import { CODE } from '../src/codes'
import { EnvelopeError } from '../src/envelope'

describe('normalizeFilePath 防护矩阵（US10）', () => {
  it('空串 = 树根（列根目录合法）', () => {
    expect(normalizeFilePath('')).toEqual({ ok: true, path: '' })
  })

  it('绝对路径（/ 开头）与反斜杠开头 → 拒', () => {
    expect(normalizeFilePath('/etc/passwd').ok).toBe(false)
    expect(normalizeFilePath('\\etc\\passwd').ok).toBe(false)
  })

  it('含反斜杠（非开头）→ 拒', () => {
    expect(normalizeFilePath('a\\b.md').ok).toBe(false)
  })

  it('目录穿越（.. 段）→ 拒', () => {
    expect(normalizeFilePath('../evil.md').ok).toBe(false)
    expect(normalizeFilePath('a/../../evil.md').ok).toBe(false)
    expect(normalizeFilePath('a/..').ok).toBe(false)
  })

  it('NUL 字节 → 拒', () => {
    expect(normalizeFilePath('a\u0000b.md').ok).toBe(false)
  })

  it('缺省（undefined/null）→ 树根（query 未传 path = 列根目录）；非字符串 → 拒', () => {
    expect(normalizeFilePath(undefined)).toEqual({ ok: true, path: '' })
    expect(normalizeFilePath(null)).toEqual({ ok: true, path: '' })
    expect(normalizeFilePath(42).ok).toBe(false)
  })

  it('归一化折叠：// 与 . 段折叠重 join', () => {
    expect(normalizeFilePath('a//b/./c.md')).toEqual({ ok: true, path: 'a/b/c.md' })
    expect(normalizeFilePath('a///')).toEqual({ ok: true, path: 'a' })
    expect(normalizeFilePath('./x.md')).toEqual({ ok: true, path: 'x.md' })
  })

  it('任意扩展/无扩展都合法（lab 沙箱文本）', () => {
    expect(normalizeFilePath('notes.txt').ok).toBe(true)
    expect(normalizeFilePath('code/main.ts').ok).toBe(true)
    expect(normalizeFilePath('README').ok).toBe(true)
  })

  it('路径长度按 Unicode code points 计（≤512；emoji 不误拒）', () => {
    const seg = 'x😀' // 2 code points / 3 code units
    const deep = Array.from({ length: 150 }, () => seg).join('/') // 3*150-1=449 cp，4*150-1=599 cu
    expect(normalizeFilePath(deep).ok).toBe(true)
    expect(Array.from((normalizeFilePath(deep) as { ok: true; path: string }).path).length).toBe(449)
    expect(normalizeFilePath(`${seg}/`.repeat(180)).ok).toBe(false) // >512 cp
  })
})

describe('normalizeFileRoot（T0 #801：lab 现役，wiki/workspace 退役）', () => {
  it('lab 合法；wiki/workspace 合法但退役（Result.ok=true，退役码判定归路由层）', () => {
    expect(normalizeFileRoot('lab')).toEqual({ ok: true, root: 'lab' })
    expect(normalizeFileRoot('wiki')).toEqual({ ok: true, root: 'wiki' })
    expect(normalizeFileRoot('workspace')).toEqual({ ok: true, root: 'workspace' })
  })

  it('其余值 → 拒（错误文案点名退役根）', () => {
    const r = normalizeFileRoot('home')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain('lab')
  })
})

describe('requireFileRoot / requireFilePath（抛信封面）', () => {
  it('requireFileRoot 非法 → EnvelopeError 90002 + data.root', () => {
    try {
      requireFileRoot('home')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(EnvelopeError)
      expect((e as EnvelopeError).code).toBe(CODE.VALIDATION_FAILED)
      expect((e as EnvelopeError).data).toHaveProperty('root')
    }
  })

  it('requireFilePath：空值（缺省/空串）默认拒 → 90002 + data.path；allowEmpty 放行树根（HTTP query 无法区分未传与空串，单一开关）', () => {
    expect(() => requireFilePath(undefined)).toThrow(EnvelopeError)
    expect(requireFilePath('a/b.md')).toBe('a/b.md')
    try {
      requireFilePath('')
      expect.unreachable()
    } catch (e) {
      expect((e as EnvelopeError).code).toBe(CODE.VALIDATION_FAILED)
      expect((e as EnvelopeError).data).toHaveProperty('path')
    }
    expect(requireFilePath(undefined, { allowEmpty: true })).toBe('')
    expect(requireFilePath('', { allowEmpty: true })).toBe('')
  })
})
