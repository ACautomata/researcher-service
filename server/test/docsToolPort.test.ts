// #908 S3 + port 行为：PluginDocsPort.extractPdfText——/lab/ 前缀白名单 + 存在性校验
// （approval 同款纪律）+ pdftotext 按页数组（\f 分页）+ PDF_EXTRACT_MAX_CHARS 超限明确
// 报错不静默截断。零新缝：fake exec 原语外部行为断言；常量字面两层锁定。

import { describe, it, expect } from 'vitest'
import {
  createPluginDocsPort,
  PluginDocsPortError,
  normalizeLabPath,
  splitPdfPages,
} from '../src/runner/docsToolPort'
import { PDF_EXTRACT_MAX_CHARS } from '../../plugins/research/values'
import { fakePrimitives } from './runnerFakes'

const CONTAINER = 'researcher-sandbox-s1'

describe('normalizeLabPath：/lab/ 前缀白名单 + 穿越拒止（approval 同款纪律）', () => {
  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn()
    } catch (e) {
      return (e as PluginDocsPortError).code
    }
    return undefined
  }

  it('合法路径归一化通过', () => {
    expect(normalizeLabPath('/lab/papers/a.pdf')).toBe('/lab/papers/a.pdf')
    expect(normalizeLabPath('/lab/a.pdf')).toBe('/lab/a.pdf')
    expect(normalizeLabPath('/lab//deep//b.pdf')).toBe('/lab/deep/b.pdf')
  })

  it('非 /lab/ 前缀（wiki/tmp/根/无关绝对路径）拒绝', () => {
    for (const bad of ['/wiki/a.pdf', '/tmp/a.pdf', '/lab', '/etc/passwd', 'lab/a.pdf', 'a.pdf', '']) {
      expect(codeOf(() => normalizeLabPath(bad))).toBe('invalid_path')
    }
  })

  it('穿越/反斜杠/空字节拒绝（前缀命中也不放行）', () => {
    const nul = String.fromCharCode(0)
    for (const bad of ['/lab/../x.pdf', '/lab/a/../../x.pdf', '/lab\\x.pdf', '/lab/a\\b.pdf', `/lab/a.pdf${nul}`]) {
      expect(codeOf(() => normalizeLabPath(bad))).toBe('invalid_path')
    }
  })
})

describe('splitPdfPages：pdftotext 输出按页数组', () => {
  it('\\f 分页；尾部 form-feed artifact 丢弃；页内空文本保留', () => {
    expect(splitPdfPages('page one\fpage two\f')).toEqual(['page one', 'page two'])
    expect(splitPdfPages('only page')).toEqual(['only page'])
    expect(splitPdfPages('a\f\fmid empty kept\flast\f')).toEqual(['a', '', 'mid empty kept', 'last'])
    expect(splitPdfPages('')).toEqual([])
  })
})

describe('extractPdfText：port 行为（fake exec 原语）', () => {
  it('happy path：test -f 存在性 → pdftotext 按页返回；命令核心固定（argv 不经 shell）', async () => {
    const mem = fakePrimitives({
      execBehavior: (_c, cmd) => {
        if (cmd[0] === 'test') return { exitCode: 0, stdout: '', stderr: '' }
        if (cmd[0] === 'pdftotext') return { exitCode: 0, stdout: '第一页\f第二页\f', stderr: '' }
        return undefined
      },
    })
    const execCalls: Array<{ container: string; cmd: string[] }> = []
    const spy: typeof mem.primitives = {
      ...mem.primitives,
      exec: async (container, cmd, opts) => {
        execCalls.push({ container, cmd })
        return mem.primitives.exec(container, cmd, opts)
      },
    }
    const port = createPluginDocsPort({ container: CONTAINER, primitives: spy })
    const r = await port.extractPdfText({ sandboxPath: '/lab/papers/a.pdf' })
    expect(r.pages).toEqual(['第一页', '第二页'])
    expect(execCalls[0]).toEqual({ container: CONTAINER, cmd: ['test', '-f', '/lab/papers/a.pdf'] })
    expect(execCalls[1]!.cmd).toEqual(['pdftotext', '/lab/papers/a.pdf', '-'])
  })

  it('存在性校验：test -f 非零 → not_found 明确报错（不触发 pdftotext）', async () => {
    const mem = fakePrimitives({
      execBehavior: (_c, cmd) => {
        if (cmd[0] === 'test') return { exitCode: 1, stdout: '', stderr: '' }
        return undefined
      },
    })
    const pdfs: string[][] = []
    const spy: typeof mem.primitives = {
      ...mem.primitives,
      exec: async (container, cmd, opts) => {
        if (cmd[0] === 'pdftotext') pdfs.push(cmd)
        return mem.primitives.exec(container, cmd, opts)
      },
    }
    const port = createPluginDocsPort({ container: CONTAINER, primitives: spy })
    await expect(port.extractPdfText({ sandboxPath: '/lab/missing.pdf' })).rejects.toMatchObject({
      name: 'PluginDocsPortError', code: 'not_found',
    })
    expect(pdfs).toEqual([])
  })

  it('超限明确报错不静默截断：报错带实际/上限字符数', async () => {
    const mem = fakePrimitives({
      execBehavior: (_c, cmd) => {
        if (cmd[0] === 'test') return { exitCode: 0, stdout: '', stderr: '' }
        if (cmd[0] === 'pdftotext') return { exitCode: 0, stdout: 'x'.repeat(500), stderr: '' }
        return undefined
      },
    })
    const port = createPluginDocsPort({ container: CONTAINER, primitives: mem.primitives, maxChars: 100 })
    await expect(port.extractPdfText({ sandboxPath: '/lab/big.pdf' })).rejects.toMatchObject({
      code: 'too_large',
      message: expect.stringContaining('500'),
    })
  })

  it('pdftotext 失败（含镜像缺 poppler 的 127）：extract_failed 带 stderr 透出', async () => {
    const mem = fakePrimitives({
      execBehavior: (_c, cmd) => {
        if (cmd[0] === 'test') return { exitCode: 0, stdout: '', stderr: '' }
        if (cmd[0] === 'pdftotext') return { exitCode: 127, stdout: '', stderr: 'OCI runtime exec failed' }
        return undefined
      },
    })
    const port = createPluginDocsPort({ container: CONTAINER, primitives: mem.primitives })
    await expect(port.extractPdfText({ sandboxPath: '/lab/a.pdf' })).rejects.toMatchObject({
      code: 'extract_failed',
      message: expect.stringContaining('poppler'),
    })
  })

  it('超时透传：pdftotext 调用带核心固定 timeoutMs（缺省 EXEC_DEFAULT_TIMEOUT_MS，可注入）', async () => {
    const mem = fakePrimitives()
    const seen: Array<{ cmd: string[]; opts?: { timeoutMs?: number } }> = []
    const spy: typeof mem.primitives = {
      ...mem.primitives,
      exec: async (container, cmd, opts) => {
        seen.push({ cmd, opts })
        return mem.primitives.exec(container, cmd, opts)
      },
    }
    const port = createPluginDocsPort({ container: CONTAINER, primitives: spy, timeoutMs: 42_000 })
    await port.extractPdfText({ sandboxPath: '/lab/a.pdf' })
    // 存在性探针 = 固定轻量 argv 不传超时（primitives 注记同口径）；pdftotext 带注入超时
    const pdf = seen.find((s) => s.cmd[0] === 'pdftotext')
    expect(pdf?.opts?.timeoutMs).toBe(42_000)
  })
})

describe('错误面与常量锁定', () => {
  it('PluginDocsPortError 携带稳定 code', () => {
    const e = new PluginDocsPortError('too_large', 'x')
    expect(e.code).toBe('too_large')
    expect(e).toBeInstanceOf(Error)
  })

  it('PDF_EXTRACT_MAX_CHARS = 1_000_000（853 §7.1 量级 ~1M 拍板）', () => {
    expect(PDF_EXTRACT_MAX_CHARS).toBe(1_000_000)
  })
})
