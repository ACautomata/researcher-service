// files REST 契约测试（#589 · 接缝 #2 信封 + Port 注入；T0 #801 只读化 + root=wiki/workspace 退役）。
// 端点 /api/v1/containers/<name>/files（仅 GET；#858 容器 CRUD 退役后本域是该前缀唯一残余）；
// root=lab 是唯一现役读面（沙箱 /lab，:name = sessionId，50002 归属门）；root=wiki/workspace →
// 60042 退役码（#858 起无容器行归属前置——退役面无数据，name 形状校验后即拒）；写面
//（PUT/POST/DELETE）与 files/raw 媒体通道随 T0 关闭 → 90005 路由不存在。信封（#312）+
// 错误映射（90002/50002/60040/60042）经 createApp 注入内存 fake FileArchive 直测域契约。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import { FileNotFound } from '../src/files/errors'
import type { DirListing, FileArchive, FileReading } from '../src/files/fsPort'
import { sandboxContainerName } from '../src/sandboxes/runtime'

// 内存 fake FileArchive：lab 读面独立树（dockerName → relPath → 内容），镜像「沙箱按 docker
// 名寻址」语义。
class FakeFileArchive implements FileArchive {
  // #776 lab 树：docker 名 →（relPath → 内容；含 \u0000 视为二进制）
  readonly labTrees = new Map<string, Map<string, string>>()
  readonly calls: { method: string; dockerName?: string; relPath: string; recursive?: boolean }[] = []

  async readLab(dockerName: string, relPath: string, recursive: boolean): Promise<DirListing | FileReading> {
    this.calls.push({ method: 'readLab', dockerName, relPath, recursive })
    const tree = this.labTrees.get(dockerName)
    if (tree === undefined) throw new FileNotFound(relPath) // 沙箱不存在/未创建 → 60040 语义
    // 目录集 = 路径前缀折叠（树根 '' 恒在）
    const dirs = new Set<string>([''])
    for (const p of tree.keys()) {
      const segs = p.split('/')
      for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'))
    }
    // 目录分支：列直接子项（recursive=false）或全子树（true）；文件分支：内容（NUL → binary）
    if (dirs.has(relPath)) {
      const children: DirListing['files'] = []
      for (const p of [...tree.keys(), ...dirs].filter((p) => p !== '')) {
        const depth = p.split('/').length
        if (recursive ? !p.startsWith(relPath === '' ? '' : `${relPath}/`) : depth !== (relPath === '' ? 1 : relPath.split('/').length + 1)) continue
        children.push({
          path: p,
          type: tree.has(p) ? 'file' : 'directory',
          size: tree.has(p) ? Buffer.byteLength(tree.get(p)!) : 0,
          modified: new Date(0).toISOString(),
        })
      }
      return { kind: 'dir', path: relPath, files: children, truncated: false }
    }
    const raw = tree.get(relPath)
    if (raw === undefined) throw new FileNotFound(relPath)
    const binary = raw.includes('\u0000')
    return {
      kind: 'file',
      path: relPath,
      content: binary ? null : raw,
      size: Buffer.byteLength(raw),
      modified: new Date(0).toISOString(),
      binary,
      oversized: false,
    }
  }

  // #780 沙箱字节读（附件下载端点）：按 docker 名取 lab 树、返回原始字节；不存在 → FileNotFound。
  async readLabBytes(dockerName: string, relPath: string): Promise<Buffer> {
    this.calls.push({ method: 'readLabBytes', dockerName, relPath })
    const tree = this.labTrees.get(dockerName)
    if (tree === undefined) throw new FileNotFound(relPath)
    const raw = tree.get(relPath)
    if (raw === undefined) throw new FileNotFound(relPath)
    return Buffer.from(raw, 'utf8')
  }
}

let seq = 0

describe('files REST（T0 #801：lab 只读 + wiki/workspace 退役）', () => {
  let ctx: TestContext
  let archive: FakeFileArchive
  const BASE = '/api/v1/containers'

  beforeAll(async () => {
    archive = new FakeFileArchive()
    ctx = await setupTestApp({ files: { archive } })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  // 会话种子：owner + 沙箱绑定（schema 契约：containerId 记沙箱 docker 名）
  async function seedSession(ownerId: string): Promise<string> {
    seq += 1
    const id = `csbx${seq.toString().padStart(4, '0')}`
    await ctx.prisma.session.create({
      data: { id, ownerId, containerId: sandboxContainerName(id), title: 'lab 读面测试' },
    })
    return id
  }

  // ---------------------------- 认证 / name / 容器归属（公共前置）----------------------------

  it('未认证 → 10001', async () => {
    const res = await ctx.request.get(`${BASE}/demo/files?root=lab&path=`)
    expect(res.body.code).toBe(10001)
  })

  it('name 非法 → 90002 + data.name（大写/非法字符）', async () => {
    await seedUser(ctx.prisma, 'finu', 'pw-finu-secure')
    const l = await login(ctx.request, 'finu', 'pw-finu-secure')
    const res = await ctx.request.get(`${BASE}/Bad_Name/files?root=lab&path=`).set(bearer(l.access))
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('name')
  })

  // ---------------------------- root=wiki / workspace 整根退役（T0 #801 · 60042；
  // #858 起无容器行归属前置，name 形状校验后即拒）----------------------------

  it('root=wiki → 60042 退役码（wiki 读走 wiki 域 REST；#858 起无容器行归属前置）', async () => {
    await seedUser(ctx.prisma, 'fret1', 'pw-fret1-secure')
    const l = await login(ctx.request, 'fret1', 'pw-fret1-secure')
    const res = await ctx.request.get(`${BASE}/legacybox/files?root=wiki&path=`).set(bearer(l.access))
    expect(res.body.code).toBe(60042)
  })

  it('root=workspace → 60042；缺省 root（legacy 前端硬发 workspace 的历史面）同退役语义', async () => {
    await seedUser(ctx.prisma, 'fret2', 'pw-fret2-secure')
    const l = await login(ctx.request, 'fret2', 'pw-fret2-secure')
    const ws = await ctx.request.get(`${BASE}/legacybox/files?root=workspace&path=`).set(bearer(l.access))
    expect(ws.body.code).toBe(60042)
    const missing = await ctx.request.get(`${BASE}/legacybox/files?path=`).set(bearer(l.access))
    expect(missing.body.code).toBe(60042)
  })

  it('admin 对退役根同样得到 60042（退役无角色豁免）', async () => {
    await seedAdmin(ctx.prisma, 'fret3a', 'pw-fret3a-secure')
    const la = await login(ctx.request, 'fret3a', 'pw-fret3a-secure')
    const res = await ctx.request.get(`${BASE}/legacybox/files?root=workspace&path=`).set(bearer(la.access))
    expect(res.body.code).toBe(60042)
  })

  it('root 非法值 → 90002 + data.root（区分于合法退役根 60042）', async () => {
    await seedUser(ctx.prisma, 'froot', 'pw-froot-secure')
    const l = await login(ctx.request, 'froot', 'pw-froot-secure')
    const res = await ctx.request.get(`${BASE}/legacybox/files?root=home&path=`).set(bearer(l.access))
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('root')
  })

  // ---------------------------- 写面 / raw 通道关闭（→ 90005 路由不存在）----------------------------

  it('PUT/POST/DELETE 写面已关闭 → 90005（files API 只读化，T0 #801）', async () => {
    await seedUser(ctx.prisma, 'fwr', 'pw-fwr-secure')
    const l = await login(ctx.request, 'fwr', 'pw-fwr-secure')
    const put = await ctx.request.put(`${BASE}/legacybox/files`).set(bearer(l.access)).send({ root: 'lab', path: 'a.md', content: 'x' })
    expect(put.body.code).toBe(90005)
    const post = await ctx.request.post(`${BASE}/legacybox/files`).set(bearer(l.access)).send({ root: 'lab', path: 'a.md', content: 'x' })
    expect(post.body.code).toBe(90005)
    const del = await ctx.request.delete(`${BASE}/legacybox/files?root=lab&path=a.md`).set(bearer(l.access))
    expect(del.body.code).toBe(90005)
    // fake 零调用（路由未挂载，archive 不被触达）
    expect(archive.calls).toHaveLength(0)
  })

  it('files/raw 媒体字节通道已关闭 → 90005', async () => {
    await seedUser(ctx.prisma, 'fraw', 'pw-fraw-secure')
    const l = await login(ctx.request, 'fraw', 'pw-fraw-secure')
    const res = await ctx.request
      .get(`${BASE}/legacybox/files/raw?path=${encodeURIComponent('/home/node/.openclaw/workspace/x.png')}`)
      .set(bearer(l.access))
    expect(res.body.code).toBe(90005)
  })

  // ---------------------------- root=lab 沙箱只读读面（#776 · S1 信封级集成）----------------------------

  it('GET root=lab 列沙箱根目录 → 200；readLab 按沙箱 docker 名寻址（researcher-sandbox-<id>）', async () => {
    const u = await seedUser(ctx.prisma, 'flab1', 'pw-flab1-secure')
    const sid = await seedSession(u.id)
    archive.labTrees.set(sandboxContainerName(sid), new Map([['notes.md', '# lab\n'], ['out/result.txt', '42']]))
    const l = await login(ctx.request, 'flab1', 'pw-flab1-secure')
    const res = await ctx.request.get(`${BASE}/${sid}/files?root=lab&path=`).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data).toMatchObject({ kind: 'dir', path: '', truncated: false })
    expect(res.body.data.files.map((f: { path: string }) => f.path)).toEqual(['notes.md', 'out'])
    expect(archive.calls.at(-1)).toMatchObject({ method: 'readLab', dockerName: sandboxContainerName(sid), relPath: '', recursive: false })
  })

  it('GET root=lab 读文件 / recursive 递归 walk', async () => {
    const u = await seedUser(ctx.prisma, 'flab2', 'pw-flab2-secure')
    const sid = await seedSession(u.id)
    archive.labTrees.set(sandboxContainerName(sid), new Map([['src/main.py', 'print(1)\n'], ['src/util.py', 'x=2\n']]))
    const l = await login(ctx.request, 'flab2', 'pw-flab2-secure')
    const file = await ctx.request.get(`${BASE}/${sid}/files?root=lab&path=src%2Fmain.py`).set(bearer(l.access))
    expect(file.body.code).toBe(0)
    expect(file.body.data).toMatchObject({ kind: 'file', path: 'src/main.py', content: 'print(1)\n', binary: false })
    const walk = await ctx.request.get(`${BASE}/${sid}/files?root=lab&path=&recursive=true`).set(bearer(l.access))
    expect(walk.body.data.files.map((f: { path: string }) => f.path).sort()).toEqual(['src', 'src/main.py', 'src/util.py'])
  })

  it('会话不存在 → 50002（与越权同码同文案同空 data，防探测）', async () => {
    await seedUser(ctx.prisma, 'flab3', 'pw-flab3-secure')
    const l = await login(ctx.request, 'flab3', 'pw-flab3-secure')
    const res = await ctx.request.get(`${BASE}/cmissing0001/files?root=lab&path=`).set(bearer(l.access))
    expect(res.body).toEqual({ code: 50002, message: expect.any(String), data: null })
  })

  it('user 越权读他人会话沙箱 → 50002，与「不存在」逐字节一致（防探测）', async () => {
    const owner = await seedUser(ctx.prisma, 'flab4o', 'pw-flab4o-secure')
    await seedUser(ctx.prisma, 'flab4v', 'pw-flab4v-secure')
    const sid = await seedSession(owner.id)
    const lv = await login(ctx.request, 'flab4v', 'pw-flab4v-secure')
    const res = await ctx.request.get(`${BASE}/${sid}/files?root=lab&path=`).set(bearer(lv.access))
    expect(res.body).toEqual({ code: 50002, message: expect.any(String), data: null })
    // 对照：不存在会话的响应形状（同码同 data）
    const miss = await ctx.request.get(`${BASE}/cmissing0002/files?root=lab&path=`).set(bearer(lv.access))
    expect(res.body).toEqual(miss.body)
  })

  it('admin 可跨用户读任意会话沙箱', async () => {
    const u = await seedUser(ctx.prisma, 'flab5', 'pw-flab5-secure')
    const sid = await seedSession(u.id)
    archive.labTrees.set(sandboxContainerName(sid), new Map([['a.md', 'hi']]))
    await seedAdmin(ctx.prisma, 'flab5a', 'pw-flab5a-secure')
    const la = await login(ctx.request, 'flab5a', 'pw-flab5a-secure')
    const res = await ctx.request.get(`${BASE}/${sid}/files?root=lab&path=a.md`).set(bearer(la.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data).toMatchObject({ kind: 'file', content: 'hi' })
  })

  it('沙箱未创建（无惰性创建——读面只读）→ 60040', async () => {
    const u = await seedUser(ctx.prisma, 'flab6', 'pw-flab6-secure')
    const sid = await seedSession(u.id) // 有会话行、无沙箱树（未 ensure）
    const l = await login(ctx.request, 'flab6', 'pw-flab6-secure')
    const res = await ctx.request.get(`${BASE}/${sid}/files?root=lab&path=`).set(bearer(l.access))
    expect(res.body.code).toBe(60040)
    expect(res.body.data).toBeNull()
  })

  it('lab path 穿越/绝对路径 → 90002 + data.path（在会话校验之后，防探测优先）', async () => {
    const u = await seedUser(ctx.prisma, 'flab7', 'pw-flab7-secure')
    const sid = await seedSession(u.id)
    const l = await login(ctx.request, 'flab7', 'pw-flab7-secure')
    for (const bad of ['../etc/passwd', '/etc/passwd', 'a\\b.txt', 'a\u0000b']) {
      const res = await ctx.request.get(`${BASE}/${sid}/files?root=lab&path=${encodeURIComponent(bad)}`).set(bearer(l.access))
      expect(res.body.code).toBe(90002)
      expect(res.body.data).toHaveProperty('path')
    }
  })

  it('跨会话沙箱隔离：同名文件各自成树（docker 名分树）', async () => {
    const u = await seedUser(ctx.prisma, 'flab9', 'pw-flab9-secure')
    const s1 = await seedSession(u.id)
    const s2 = await seedSession(u.id)
    archive.labTrees.set(sandboxContainerName(s1), new Map([['shared.md', 'from-s1']]))
    archive.labTrees.set(sandboxContainerName(s2), new Map([['shared.md', 'from-s2']]))
    const l = await login(ctx.request, 'flab9', 'pw-flab9-secure')
    const r1 = await ctx.request.get(`${BASE}/${s1}/files?root=lab&path=shared.md`).set(bearer(l.access))
    const r2 = await ctx.request.get(`${BASE}/${s2}/files?root=lab&path=shared.md`).set(bearer(l.access))
    expect(r1.body.data.content).toBe('from-s1')
    expect(r2.body.data.content).toBe('from-s2')
  })
})
