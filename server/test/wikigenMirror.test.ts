// wiki 治理生成落地镜像单测（#790 · S2 接缝：Docker 原语注入 fake，零 daemon）。
// 验收③的机制面：整树落地（含 log.md/INSTRUCTIONS.md/.claims——与 #789 检索镜像的 SKIP 过滤
// 行为相反，显式用例锁定）、git init、treeHash 确定性（pull 侧与 finish 复检侧同一实现——
// 口径漂移 = base-hash 永假冲突）、pushBack 归档范围（只 openwiki/** 子树、无镜像根 .git 条目）
// 与删除语义（diff + exec rm——putArchive 只覆盖不删除，漏删 = 静默留 stale 页）。

import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, rmSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  pullWikiGenerationMirror,
  pushBackWikiGenerationMirror,
  readContainerWikiTree,
} from '../src/runner/wikigen/mirror'
import { fakePrimitives } from './runnerFakes'
import { parseTar } from '../src/files/tar'
import type { SandboxFilePrimitives } from '../src/runner/backend/primitives'

const WIKI = 'researcher-wiki-u1'
const enc = (s: string) => Buffer.from(s, 'utf8')
const cleanupDirs: string[] = []

afterAll(() => {
  for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true })
})

// fake wiki 容器树：两页知识页 + 运行文件（生成镜像必须带上它们——检索镜像反而过滤）
function seededFake(): ReturnType<typeof fakePrimitives> {
  const fake = fakePrimitives()
  fake.trees.set(
    WIKI,
    new Map<string, Buffer | 'dir'>([
      ['/wiki', 'dir'],
      ['/wiki/concepts', 'dir'],
      ['/wiki/concepts/attention.md', enc('# Attention\n\nv1\n')],
      ['/wiki/concepts/transformer.md', enc('# Transformer\n')],
      ['/wiki/index.md', enc('# INDEX\n')],
      ['/wiki/log.md', enc('# Log\n')],
      ['/wiki/INSTRUCTIONS.md', enc('# How\n')],
      ['/wiki/.claims', 'dir'],
      ['/wiki/.claims/concepts', 'dir'],
      ['/wiki/.claims/concepts/attention.json', enc('[]\n')],
    ]),
  )
  return fake
}

// pushBack 的 exec rm 在 fake 原语里默认只记录不生效——注入与真容器同形的删除行为
//（`sh -c '...rm -rf -- "$1"' 'sh' <abs>` 的第 4 参 = 容器内绝对路径），使「容器终态树」
// 断言与真 Docker 语义一致。
function withRealRm(fake: ReturnType<typeof fakePrimitives>): void {
  fake.primitives.exec = async (container, cmd) => {
    fake.execCalls.push({ container, cmd })
    // argv 形态 ['sh','-c',script,'sh',<abs>]——路径在第 5 参（对齐 dockerArchiveBackend.delete）
    if (cmd[0] === 'sh' && typeof cmd[4] === 'string') {
      const target = cmd[4]
      const t = fake.trees.get(container)
      if (t) for (const key of [...t.keys()]) if (key === target || key.startsWith(`${target}/`)) t.delete(key)
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

// 观察缝：记录进入 putArchive 的 tar 条目名（推回归档范围断言——fake 不保存 tar）
function withTarRecording(fake: ReturnType<typeof fakePrimitives>): string[][] {
  const recorded: string[][] = []
  const inner = fake.primitives.putArchive.bind(fake.primitives) as SandboxFilePrimitives['putArchive']
  fake.primitives.putArchive = async (container, dir, tar) => {
    recorded.push(parseTar(tar, {}).map((e) => e.name))
    await inner(container, dir, tar)
  }
  return recorded
}

describe('pullWikiGenerationMirror（#790 落地副本）', () => {
  it('整树落地 <root>/openwiki/**：运行文件（log.md/INSTRUCTIONS.md/.claims）保留（与检索镜像 SKIP 行为相反）；镜像根含 .git；dispose 删目录', async () => {
    const fake = seededFake()
    const mirror = await pullWikiGenerationMirror(fake.primitives, WIKI)
    cleanupDirs.push(mirror.root)
    expect(mirror.root.startsWith(join(tmpdir(), 'wiki-gen-'))).toBe(true)
    expect(mirror.openwikiDir).toBe(join(mirror.root, 'openwiki'))
    // 知识页 + 运行文件全部落地（生成需要 log.md/.claims/.run.json 面）
    expect(statSync(join(mirror.openwikiDir, 'concepts', 'attention.md')).isFile()).toBe(true)
    expect(statSync(join(mirror.openwikiDir, 'log.md')).isFile()).toBe(true)
    expect(statSync(join(mirror.openwikiDir, 'INSTRUCTIONS.md')).isFile()).toBe(true)
    expect(statSync(join(mirror.openwikiDir, '.claims', 'concepts', 'attention.json')).isFile()).toBe(true)
    // git init（openwiki 生命周期边界 resolveRepositoryRoot 硬依赖 git 根）
    expect(existsSync(join(mirror.root, '.git'))).toBe(true)
    await mirror.dispose()
    expect(() => statSync(mirror.root)).toThrow()
  })

  it('容器树缺失（getArchive null）→ 拒绝', async () => {
    await expect(pullWikiGenerationMirror(fakePrimitives().primitives, WIKI)).rejects.toThrow(/unavailable/)
  })

  it('baselineHash = pull 时刻容器树 hash；同树复检同值（单一实现同一口径），单字节之差即变', async () => {
    const fake = seededFake()
    const mirror = await pullWikiGenerationMirror(fake.primitives, WIKI)
    cleanupDirs.push(mirror.root)
    // 复检侧同函数同口径：树未变 → hash 相等
    const recheck = await readContainerWikiTree(fake.primitives, WIKI)
    expect(recheck).not.toBeNull()
    expect(recheck!.hash).toBe(mirror.baselineHash)
    // dotfile（.claims/**）计入 hash：只动旁车也算容器树变更（轻写通道防护不漏）
    const t = fake.trees.get(WIKI)!
    t.set('/wiki/.claims/concepts/attention.json', enc('[{"x":1}]\n'))
    expect((await readContainerWikiTree(fake.primitives, WIKI))!.hash).not.toBe(mirror.baselineHash)
    // 恢复后 hash 复原（确定性：内容决定 hash，与读取次数无关）
    t.set('/wiki/.claims/concepts/attention.json', enc('[]\n'))
    expect((await readContainerWikiTree(fake.primitives, WIKI))!.hash).toBe(mirror.baselineHash)
    // 单字节内容差 → hash 变
    t.set('/wiki/concepts/attention.md', enc('# Attention\n\nv2\n'))
    expect((await readContainerWikiTree(fake.primitives, WIKI))!.hash).not.toBe(mirror.baselineHash)
  })

  it('readContainerWikiTree：文件清单含 dotfile 且排序；树缺失 → null', async () => {
    const fake = seededFake()
    const snapshot = await readContainerWikiTree(fake.primitives, WIKI)
    expect(snapshot!.files).toEqual([
      '.claims/concepts/attention.json',
      'INSTRUCTIONS.md',
      'concepts/attention.md',
      'concepts/transformer.md',
      'index.md',
      'log.md',
    ])
    expect(await readContainerWikiTree(fakePrimitives().primitives, WIKI)).toBeNull()
  })
})

describe('pushBackWikiGenerationMirror（#790 推回）', () => {
  it('覆盖改写页 + 新增页 + 删除镜像中已不存在的页（exec rm 调用与容器终态树）；归档范围只 openwiki/** 子树、无镜像根 .git/AGENTS.md 条目', async () => {
    const fake = seededFake()
    withRealRm(fake)
    const tars = withTarRecording(fake)
    const mirror = await pullWikiGenerationMirror(fake.primitives, WIKI)
    cleanupDirs.push(mirror.root)
    // 治理副本内：改写一页、新增一页、删除一页（openwiki 计划删页 → 镜像缺位）
    await writeFile(join(mirror.openwikiDir, 'concepts', 'attention.md'), '# Attention\n\nv2 (updated by generation)\n')
    await mkdir(join(mirror.openwikiDir, 'workflows'), { recursive: true })
    await writeFile(join(mirror.openwikiDir, 'workflows', 'update.md'), '# Update workflow\n')
    await rm(join(mirror.openwikiDir, 'concepts', 'transformer.md'))
    // 镜像根（openwiki 之外）的文件（openwiki ensureCodeModeRepoSetup 会写 AGENTS.md）不得进推回
    await writeFile(join(mirror.root, 'AGENTS.md'), '# code-mode snippet\n')

    const before = fake.execCalls.length
    const result = await pushBackWikiGenerationMirror(fake.primitives, WIKI, mirror.root)
    expect(result.pushedFiles).toBe(6) // attention + workflows/update + index + log + INSTRUCTIONS + .claims 旁车
    expect(result.removedFiles).toEqual(['concepts/transformer.md'])
    expect(fake.execCalls.length).toBe(before + 1)
    expect(fake.execCalls.at(-1)!.cmd).toContain('/wiki/concepts/transformer.md')

    // 容器终态树：推回内容落位 + 删除生效
    const t = fake.trees.get(WIKI)!
    expect(await readFile(join(mirror.openwikiDir, 'concepts', 'attention.md'))).toEqual(t.get('/wiki/concepts/attention.md'))
    expect(t.get('/wiki/workflows/update.md')).toEqual(enc('# Update workflow\n'))
    expect(t.has('/wiki/concepts/transformer.md')).toBe(false)
    // 归档范围：条目名全部相对 openwiki 子树（无 'openwiki/' 前缀、无镜像根 '.git/'、无 'AGENTS.md'）
    const names = tars.at(-1)!
    expect(names.length).toBeGreaterThan(0)
    expect(names.every((n) => !n.startsWith('openwiki/'))).toBe(true)
    expect(names.some((n) => n.startsWith('.git/') || n === 'AGENTS.md' || n === '.git')).toBe(false)
    expect(names).toEqual(expect.arrayContaining(['concepts/attention.md', '.claims/concepts/attention.json', 'log.md']))
  })

  it('先 put 后 rm（崩溃窗口留 stale 页优于缺页）：putArchive 先于 exec rm', async () => {
    const fake = seededFake()
    withRealRm(fake)
    const order: string[] = []
    const innerPut = fake.primitives.putArchive.bind(fake.primitives) as SandboxFilePrimitives['putArchive']
    fake.primitives.putArchive = async (c, d, tar) => {
      order.push('put')
      await innerPut(c, d, tar)
    }
    const innerExec = fake.primitives.exec.bind(fake.primitives) as SandboxFilePrimitives['exec']
    fake.primitives.exec = async (c, cmd, opts) => {
      order.push('rm')
      return innerExec(c, cmd, opts)
    }
    const mirror = await pullWikiGenerationMirror(fake.primitives, WIKI)
    cleanupDirs.push(mirror.root)
    await rm(join(mirror.openwikiDir, 'concepts', 'transformer.md'))
    await pushBackWikiGenerationMirror(fake.primitives, WIKI, mirror.root)
    expect(order).toEqual(['put', 'rm'])
  })

  it('base-hash 冲突判定素材：容器树在 run 期间被轻写 → 复检 hash ≠ baseline（调用方据此中止推回）', async () => {
    const fake = seededFake()
    const mirror = await pullWikiGenerationMirror(fake.primitives, WIKI)
    cleanupDirs.push(mirror.root)
    fake.trees.get(WIKI)!.set('/wiki/concepts/lightwrite.md', enc('# concurrent\n'))
    const current = await readContainerWikiTree(fake.primitives, WIKI)
    expect(current!.hash).not.toBe(mirror.baselineHash)
  })
})
