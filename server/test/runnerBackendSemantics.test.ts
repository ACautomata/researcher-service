// runner backend 纯逻辑单测（S3 层）：semantics/mime/paths/globmatch 逐语义锁定
// deepagents@1.14.1 官方行为（#747 S2/S3 接缝——「V1 硬编码 + 测试锁定」先例）。
// 语义镜像来源（升级基座时按上游核对）：
//   normalizeReadPagination / performStringReplacement / checkEmptyContent / MIME 表
//   / isTextMimeType —— deepagents dist langsmith chunk 原文。
// 此层不触 Docker；backend 全方法行为见 dockerArchiveBackend.test.ts（fake 原语）。

import { describe, it, expect } from 'vitest'
import { normalizePagination, paginateReadLines, performStringReplacement } from '../src/runner/backend/semantics'
import { getMimeType, isTextMimeType } from '../src/runner/backend/mime'
import { routePath } from '../src/runner/backend/paths'
import { matchGlobPattern, matchGlobBaseName } from '../src/runner/backend/globmatch'

describe('normalizePagination（镜像 deepagents normalizeReadPagination）', () => {
  it('常规值取整保留', () => {
    expect(normalizePagination(3, 10)).toEqual({ offset: 3, limit: 10 })
  })
  it('负数/NaN/Infinity → 0', () => {
    expect(normalizePagination(-5, -1)).toEqual({ offset: 0, limit: 0 })
    expect(normalizePagination(NaN, NaN)).toEqual({ offset: 0, limit: 0 })
    expect(normalizePagination(Infinity, Infinity)).toEqual({ offset: 0, limit: 0 })
  })
  it('浮点向下取整', () => {
    expect(normalizePagination(2.9, 9.7)).toEqual({ offset: 2, limit: 9 })
  })
})

describe('paginateReadLines（read 行分页纯逻辑）', () => {
  const FIVE_LINES = 'a\nb\nc\nd\ne' // 5 行无尾换行

  it('首页：startLine=1/endLine=limit，末尾页 nextOffset 缺省', () => {
    const r = paginateReadLines(FIVE_LINES, 0, 3)
    expect(r).toEqual({ content: 'a\nb\nc', totalLines: 5, startLine: 1, endLine: 3, nextOffset: 3 })
  })
  it('中间页：offset 0-indexed，nextOffset=endLine 供续读', () => {
    const r = paginateReadLines(FIVE_LINES, 3, 2)
    expect(r).toEqual({ content: 'd\ne', totalLines: 5, startLine: 4, endLine: 5, nextOffset: undefined })
  })
  it('尾换行不计入行数：totalLines 剔除末尾空段，content 保留原文', () => {
    const r = paginateReadLines('a\nb\n', 0, 10)
    expect(r).toEqual({ content: 'a\nb\n', totalLines: 2, startLine: 1, endLine: 2, nextOffset: undefined })
  })
  it('offset 越界 → error（对齐官方 Line offset exceeds 文案）', () => {
    const r = paginateReadLines(FIVE_LINES, 5, 3)
    expect(r).toEqual({ error: 'Line offset 5 exceeds file length (5 lines)' })
  })
  it('offset==totalLines 同样越界（末行已读完）', () => {
    const r = paginateReadLines('a\n', 1, 10)
    expect('error' in r && r.error).toBe('Line offset 1 exceeds file length (1 lines)')
  })
  it('limit=0 → 仅 content（官方空选择分支：不带分页字段）', () => {
    expect(paginateReadLines(FIVE_LINES, 0, 0)).toEqual({ content: '' })
  })
})

describe('performStringReplacement（镜像 deepagents edit 合成）', () => {
  it('唯一命中：替换 + occurrences=1', () => {
    expect(performStringReplacement('hello world', 'world', 'there')).toEqual(['hello there', 1])
  })
  it('多命中且 replaceAll=false → error（要求唯一/更精确）', () => {
    const r = performStringReplacement('a x b x c', 'x', 'y')
    expect(typeof r).toBe('string')
    expect(r as string).toContain('multiple occurrences')
  })
  it('replaceAll=true：全替换 + occurrences 计数', () => {
    expect(performStringReplacement('a x b x c', 'x', 'y', true)).toEqual(['a y b y c', 2])
  })
  it('未命中 → not found error', () => {
    const r = performStringReplacement('abc', 'zzz', 'y')
    expect(r).toBe("Error: String not found in file: 'zzz'")
  })
  it('空文件 + 空 oldString → 初始化为 newString（occurrences=0，官方特判）', () => {
    expect(performStringReplacement('', '', 'init')).toEqual(['init', 0])
  })
  it('非空文件 + 空 oldString → error', () => {
    expect(performStringReplacement('abc', '', 'x')).toContain('oldString cannot be empty')
  })
})

describe('mime（镜像 deepagents MIME_TYPES / isTextMimeType）', () => {
  it('常见扩展名映射', () => {
    expect(getMimeType('a.md')).toBe('text/markdown')
    expect(getMimeType('a.PNG'.toLowerCase())).toBe('image/png')
    expect(getMimeType('a.png')).toBe('image/png')
    expect(getMimeType('a.json')).toBe('application/json')
    expect(getMimeType('a.pdf')).toBe('application/pdf')
    expect(getMimeType('a.svg')).toBe('image/svg+xml')
  })
  it('源码类按 text/plain（官方表：.ts/.py/.sh 等）', () => {
    expect(getMimeType('x.ts')).toBe('text/plain')
    expect(getMimeType('x.py')).toBe('text/plain')
    expect(getMimeType('x.sh')).toBe('text/plain')
    expect(getMimeType('x.yaml')).toBe('text/plain')
  })
  it('未知扩展名 → text/plain（官方默认，非 octet-stream）', () => {
    expect(getMimeType('x.unknownext')).toBe('text/plain')
    expect(getMimeType('noext')).toBe('text/plain')
  })
  it('isTextMimeType 边界：text/* + json/javascript/svg+xml 为文本', () => {
    expect(isTextMimeType('text/markdown')).toBe(true)
    expect(isTextMimeType('application/json')).toBe(true)
    expect(isTextMimeType('application/javascript')).toBe(true)
    expect(isTextMimeType('image/svg+xml')).toBe(true)
    expect(isTextMimeType('image/png')).toBe(false)
    expect(isTextMimeType('application/pdf')).toBe(false)
  })
})

describe('routePath（双根路由纯函数：/wiki/ → wiki 容器，/lab/ → 沙箱容器）', () => {
  const targets = { wiki: 'researcher-wiki-u1', lab: 'researcher-sandbox-s1' }

  it('/wiki/** 分派 wiki 容器，容器内路径 = 根前缀保留', () => {
    expect(routePath('/wiki/notes/a.md', targets)).toEqual({
      container: 'researcher-wiki-u1',
      absPath: '/wiki/notes/a.md',
    })
  })
  it('/lab/** 分派沙箱容器', () => {
    expect(routePath('/lab/src/main.py', targets)).toEqual({
      container: 'researcher-sandbox-s1',
      absPath: '/lab/src/main.py',
    })
  })
  it('归一化：双斜杠折叠、尾斜杠去除、单点段折叠', () => {
    expect(routePath('//wiki//a///b.md/', targets)).toEqual({
      container: 'researcher-wiki-u1',
      absPath: '/wiki/a/b.md',
    })
    expect(routePath('/wiki/./a.md', targets)).toEqual({
      container: 'researcher-wiki-u1',
      absPath: '/wiki/a.md',
    })
  })
  it('双点段（穿越）拒绝：任何位置的 .. → error 且不携带容器', () => {
    for (const p of ['/wiki/../b.md', '/wiki/a/../../b.md', '/wiki/..']) {
      const r = routePath(p, targets)
      expect('error' in r, `path=${JSON.stringify(p)} 应被拒`).toBe(true)
    }
  })
  it('根本身合法（目录操作目标）：/wiki 与 /lab', () => {
    expect(routePath('/wiki', targets)).toEqual({ container: 'researcher-wiki-u1', absPath: '/wiki' })
    expect(routePath('/lab', targets)).toEqual({ container: 'researcher-sandbox-s1', absPath: '/lab' })
  })
  it('错误路径：相对路径/未知根/空/反斜杠/NUL → error 且不携带容器', () => {
    for (const p of ['wiki/a.md', '/etc/passwd', '', '/', '/WIKI/a.md', '/wiki\\a.md', '/wiki/a\u0000b']) {
      const r = routePath(p, targets)
      expect('error' in r, `path=${JSON.stringify(p)} 应被拒`).toBe(true)
    }
  })
})

describe('globmatch（micromatch 包装：glob 全语义 / grep basename 语义）', () => {
  it('matchGlobPattern：**/*.md 跨目录匹配（dotfile 含点文件）', () => {
    expect(matchGlobPattern('notes/a.md', '**/*.md')).toBe(true)
    expect(matchGlobPattern('a.md', '**/*.md')).toBe(true)
    expect(matchGlobPattern('notes/a.py', '**/*.md')).toBe(false)
    expect(matchGlobPattern('.hidden/a.md', '**/*.md')).toBe(true) // dot:true
  })
  it('matchGlobPattern：目录前缀模式 dir/**、基目录直接子项 * / ? / []', () => {
    expect(matchGlobPattern('src/deep/x.ts', 'src/**')).toBe(true)
    expect(matchGlobPattern('other/x.ts', 'src/**')).toBe(false)
    // 模式相对搜索基目录：draft-?.md 只匹配基目录直接子项（跨目录需 **/draft-?.md）
    expect(matchGlobPattern('draft-1.md', 'draft-?.md')).toBe(true)
    expect(matchGlobPattern('notes/draft-1.md', 'draft-?.md')).toBe(false)
    expect(matchGlobPattern('notes/draft-1.md', '**/draft-?.md')).toBe(true)
    expect(matchGlobPattern('draft-12.md', 'draft-?.md')).toBe(false)
    expect(matchGlobPattern('draft-a.md', 'draft-[ab].md')).toBe(true)
    expect(matchGlobPattern('draft-c.md', 'draft-[ab].md')).toBe(false)
  })
  it('matchGlobPattern：反斜杠路径段归一（容器内恒为 /）', () => {
    expect(matchGlobPattern('notes/a.md', 'notes/*.md')).toBe(true)
  })
  it('matchGlobBaseName：只看文件名段（grep includeGlob 官方语义）', () => {
    expect(matchGlobBaseName('/lab/src/main.py', '*.py')).toBe(true)
    expect(matchGlobBaseName('/lab/src/main.py', 'src/*.py')).toBe(false) // basename 语义：含 / 模式不匹配 basename
    expect(matchGlobBaseName('/lab/src/main.ts', '*.py')).toBe(false)
  })
})
