// #912 S2：ctx.lab 核心实现（853 §11.3B 形态②）——写面 /lab/specs/ 固定前缀白名单 +
// 归一化纪律（docsToolPort.normalizeLabPath 同族）、父目录自动创建（exec mkdir -p +
// putArchive 单文件 tar——无 shell 转义面）、读面 /lab/ 前缀 + test -f 探针 + getArchive
// 收集（MAX_FILE_READ_BYTES 护栏 + NUL 嗅探同 fsPort.readLab 口径）。零 LLM 纯端口 fake。
import { describe, expect, it } from 'vitest'
import { createPluginLabPort, normalizeSpecsPath } from '../src/runner/labToolPort'
import { normalizeLabPath } from '../src/runner/docsToolPort'
import { createTarTree, parseTar } from '../src/files/tar'
import type { SandboxFilePrimitives } from '../src/runner/backend/primitives'

// exec/putArchive/getArchive 内存 fake：files = 容器内绝对路径文件表（key 带 /lab/ 前缀）。
// putArchive 解 tar（normalizeTarName 相对名展开到 dir）；getArchive 按请求 dir 打该子树
// tar（相对名）——对齐真原语「tar 名相对传入路径展开」语义。
function labFake(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const exec = async (_c: string, cmd: string[]) => {
    if (cmd[0] === 'test' && cmd[1] === '-f') {
      return { exitCode: files.has(cmd[2]!) ? 0 : 1, stdout: '', stderr: '' }
    }
    if (cmd[0] === 'mkdir' && cmd[1] === '-p') return { exitCode: 0, stdout: '', stderr: '' }
    return { exitCode: 127, stdout: '', stderr: 'unexpected' }
  }
  const putArchive = async (_c: string, dir: string, tar: Buffer) => {
    for (const entry of parseTar(tar, { collectData: true })) {
      if (entry.type === 'file' && entry.data !== null) files.set(`${dir}/${entry.name}`, entry.data.toString('utf8'))
    }
  }
  const getArchive = async (_c: string, filePath: string) => {
    // 真原语直打文件路径语义（dockerFs.probeFile 先例）：daemon 返**单文件** tar，
    // tar 名 = basename。fake 对未知路径返空 tar（条目找不到 → 与真实行为同形）。
    const content = files.get(filePath)
    if (content === undefined) return createTarTree([])
    return createTarTree([{ name: baseName(filePath), type: 'file' as const, content: Buffer.from(content, 'utf8'), mtimeSec: 0 }])
  }
  const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
  const primitives = { exec, putArchive, getArchive } as unknown as SandboxFilePrimitives
  return { files, port: createPluginLabPort({ container: 'researcher-sandbox-x', primitives }) }
}

describe('normalizeSpecsPath（写面白名单：/lab/specs/ 固定前缀）', () => {
  it('合法 specs 路径归一化（空段/单点坍缩）', () => {
    expect(normalizeSpecsPath('/lab/specs/ab12/spec.md')).toBe('/lab/specs/ab12/spec.md')
    expect(normalizeSpecsPath('/lab//specs//ab12/./spec.md')).toBe('/lab/specs/ab12/spec.md')
  })

  it('非 /lab/specs/ 前缀 → invalid_path（写面窄口径——交付物结果文件不在写面）', () => {
    for (const bad of ['/lab/results/a.json', '/lab/uploads/x.md', '/lab/specs.md']) {
      expect(() => normalizeSpecsPath(bad)).toThrowError(/\/lab\/specs\//)
    }
    // /lab/ 前缀面之外的路径先落 normalizeLabPath 的拒面（同族纪律）。
    expect(() => normalizeSpecsPath('/tmp/spec.md')).toThrowError(/\/lab\//)
  })

  it('穿越/反斜杠/空字节/超长 → invalid_path（normalizeLabPath 同族纪律）', () => {
    expect(() => normalizeSpecsPath('/lab/specs/../secret.md')).toThrow()
    expect(() => normalizeSpecsPath('/lab/specs/a\\b.md')).toThrow()
    expect(() => normalizeSpecsPath('/lab/specs/\0b.md')).toThrow()
  })

  it('normalizeLabPath 兼容（/lab/ 全前缀合法——读面共用归一化）', () => {
    expect(normalizeLabPath('/lab/results/a.json')).toBe('/lab/results/a.json')
  })
})

describe('createPluginLabPort（S2 fake 原语）', () => {
  it('write：spec 落盘（父目录自动创建）+ read 回读对账', async () => {
    const { port } = labFake()
    const w = await port.write({ path: '/lab/specs/s1/spec.md', content: '# spec\n9 段内容' })
    expect(w).toEqual({ ok: true, data: { written: true } })

    const r = await port.read({ path: '/lab/specs/s1/spec.md' })
    expect(r).toEqual({ ok: true, data: { content: '# spec\n9 段内容' } })
  })

  it('write：修订覆盖语义（同路径再写 = 内容替换——幂等短路点的覆盖面）', async () => {
    const { port } = labFake()
    await port.write({ path: '/lab/specs/s1/spec.md', content: 'v1' })
    await port.write({ path: '/lab/specs/s1/spec.md', content: 'v2' })
    const r = await port.read({ path: '/lab/specs/s1/spec.md' })
    expect(r.ok && r.data.content).toBe('v2')
  })

  it('write：非 specs 前缀 → invalid_path Result（不触原语）', async () => {
    const { port } = labFake()
    const r = await port.write({ path: '/lab/results/a.json', content: '{}' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_path')
  })

  it('read：缺失 → not_found；读面可越 specs 树（collect 对账交付物）', async () => {
    const { port } = labFake({ '/lab/results/ablation.json': '{"auroc": 95.1}' })
    const missing = await port.read({ path: '/lab/results/none.json' })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('not_found')
    const hit = await port.read({ path: '/lab/results/ablation.json' })
    expect(hit.ok && hit.data.content).toBe('{"auroc": 95.1}')
  })

  it('read：非法路径 → invalid_path（穿越拒止）', async () => {
    const { port } = labFake()
    const r = await port.read({ path: '/lab/../etc/passwd' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_path')
  })

  it('infra 面故障 → sandbox_unavailable（exec 原生抛错归类；永不 throw 的 Result 契约）', async () => {
    const broken = {
      exec: async () => {
        throw new Error('connect ECONNREFUSED')
      },
    } as unknown as SandboxFilePrimitives
    const port = createPluginLabPort({ container: 'gone', primitives: broken })
    const r = await port.read({ path: '/lab/specs/s1/spec.md' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('sandbox_unavailable')
  })

  it('二进制嗅探：NUL 字节 → 拒（collect 对账交付物是文本 JSON/CSV/md 面）', async () => {
    const { files, port } = labFake()
    files.set('/lab/results/bin.json', 'a\u0000b')
    const r = await port.read({ path: '/lab/results/bin.json' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('binary')
  })
})
