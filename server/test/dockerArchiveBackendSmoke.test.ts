// DockerArchiveBackend 集成 smoke（#747 S2 接缝真 daemon 侧 · issue #772 验收 3/4）。
// 门控：docker daemon 不可达 → describe.skipIf 整套跳过（先例 smokeGating.ts 探测；
// 「自动探测门控，有 daemon 时跑」——不继承 containers-smoke 的 hard-fail 语义，本 smoke
// 是基座组件的可选集成证据，单测（fake-Docker）才是 S2 常开防线）。
// 覆盖：
//   1. 双根端到端（busybox 双容器真 getArchive/putArchive/exec）：write→read/edit/glob/grep/ls/delete
//   2. /wiki/ 与 /lab/ 路由按容器目标正确分派（跨容器同名文件隔离即证据）
//   3. execute 性能量级不回退（PoC #724 基线：exec mean 47.7ms / p95 70.6ms；~5x 余量断言
//      mean<250ms / p95<500ms，实测数字打印供校准）
//   4. execute 超时 kill 真 daemon 证据（评审 M2：挂起命令被容器内 timeout KILL → exitCode 124）

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Docker from 'dockerode'
import { DockerArchiveBackend } from '../src/runner/backend/dockerArchiveBackend'
import { DockerPrimitives } from '../src/runner/backend/dockerPrimitives'
import { probeDockerAvailable } from './smokeGating'
import { ensureImageAvailable } from './smokeDocker'

const IMAGE = 'busybox:1.36'
const WIKI = `researcher-smoke-wiki-${process.pid}`
const LAB = `researcher-smoke-sandbox-${process.pid}`

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0

// 模块级一次探测：skipIf 与 hooks guard 共用（vitest 的 skipIf 只跳 tests，hooks 照跑——
// hooks 内必须同条件 guard，否则跳过路径上 beforeAll/afterAll 访问未初始化对象）。
const DOCKER_UP = probeDockerAvailable()

// DOCKER_HOST 由传输层 docker-modem 原生支持（unix:// socketPath 自动解析）——new Docker()
// 与 DockerPrimitives 默认构造一致认 env，colima 等环境无需任何特判代码。

describe.skipIf(!DOCKER_UP)('DockerArchiveBackend 集成 smoke（真 docker daemon）', () => {
  let docker: Docker
  let backend: DockerArchiveBackend

  beforeAll(async () => {
    if (!DOCKER_UP) return
    docker = new Docker()
    await ensureImageAvailable(IMAGE)
    for (const name of [WIKI, LAB]) {
      const c = await docker.createContainer({
        name,
        Image: IMAGE,
        Cmd: ['sleep', '3600'],
        StopTimeout: 1,
      })
      await c.start()
    }
    backend = new DockerArchiveBackend(new DockerPrimitives(), { wiki: WIKI, lab: LAB })
  }, 120_000)

  afterAll(async () => {
    if (!DOCKER_UP) return
    for (const name of [WIKI, LAB]) {
      await docker.getContainer(name).remove({ force: true }).catch(() => {})
    }
  })

  it('双根端到端：/lab 写入→读回→编辑→检索→列目录→删除（真 getArchive/putArchive/exec）', async () => {
    // write（mkdir -p + putArchive）→ read 分页
    const w = await backend.write('/lab/src/main.py', 'print("hi")\n# TODO: x\n')
    expect(w).toMatchObject({ path: '/lab/src/main.py', filesUpdate: null })

    const r = await backend.read('/lab/src/main.py')
    expect(r).toMatchObject({ content: 'print("hi")\n# TODO: x\n', mimeType: 'text/plain', totalLines: 2 })

    // edit 合成（多命中拒绝 + replaceAll）
    const e1 = await backend.edit('/lab/src/main.py', '# TODO: x', '# TODO: y')
    expect(e1.occurrences).toBe(1)
    const e2 = await backend.edit('/lab/src/main.py', 'print', 'echo', false)
    expect(e2.error).toBeUndefined() // 唯一命中（编辑后只剩一处 print）
    expect((await backend.read('/lab/src/main.py')).content).toBe('echo("hi")\n# TODO: y\n')

    // 第二个文件供 glob/grep
    await backend.write('/lab/notes.md', '# notes\nhello lab\n')
    const g = await backend.glob('**/*.md', '/lab')
    expect(g.files!.map((f) => f.path)).toEqual(['/lab/notes.md'])
    const gr = await backend.grep('hello', '/lab')
    expect(gr.matches).toEqual([{ path: '/lab/notes.md', line: 2, text: 'hello lab' }])

    // ls：目录带尾 /、排序
    const ls = await backend.ls('/lab')
    expect(ls.files!.map((f) => `${f.path}:${f.is_dir ? 'd' : 'f'}`)).toEqual(['/lab/notes.md:f', '/lab/src/:d'])

    // delete 递归 + readRaw（二进制 mime 用 .png——.bin 在 deepagents 官方表外属 text/plain）
    await backend.write('/lab/raw.png', Buffer.from([1, 2, 3]).toString('base64'))
    const raw = await backend.readRaw('/lab/raw.png')
    expect(raw.data && 'content' in raw.data && raw.data.content).toBeInstanceOf(Uint8Array)
    const d = await backend.delete('/lab/src')
    expect(d).toEqual({ path: '/lab/src' })
    expect((await backend.read('/lab/src/main.py')).error).toBeTruthy()
  }, 60_000)

  it('路由按容器目标正确分派：/wiki/ 与 /lab/ 跨容器同名文件字节隔离', async () => {
    await backend.write('/wiki/notes.md', '# wiki notes\nwiki body\n')
    await backend.write('/lab/notes.md', '# lab notes\nlab body\n')

    const wiki = await backend.read('/wiki/notes.md')
    const lab = await backend.read('/lab/notes.md')
    expect(wiki.content).toBe('# wiki notes\nwiki body\n')
    expect(lab.content).toBe('# lab notes\nlab body\n')

    // grep 各自只见本容器内容（路由分派的反向证据）
    const gw = await backend.grep('wiki body', '/wiki')
    expect(gw.matches).toEqual([{ path: '/wiki/notes.md', line: 2, text: 'wiki body' }])
    const gl = await backend.grep('lab body', '/lab')
    expect(gl.matches).toEqual([{ path: '/lab/notes.md', line: 2, text: 'lab body' }])
    expect((await backend.grep('lab body', '/wiki')).matches).toEqual([])

    // execute 写沙箱可见、wiki 容器不可见（shell 固定落 /lab）
    await backend.execute('echo sandbox-mark > /lab/from-shell.txt')
    expect((await backend.read('/lab/from-shell.txt')).content).toBe('sandbox-mark\n')
  }, 60_000)

  it('execute 性能量级不回退（PoC 基线 mean 47.7ms / p95 70.6ms；~5x 余量断言，实测打印校准）', async () => {
    const N = 32
    const lat: number[] = []
    for (let i = 0; i < N; i++) {
      const t0 = performance.now()
      const r = await backend.execute('echo ok')
      lat.push(performance.now() - t0)
      expect(r.exitCode).toBe(0)
      expect(r.output).toContain('ok')
    }
    lat.sort((a, b) => a - b)
    const mean = lat.reduce((s, x) => s + x, 0) / lat.length
    const p95 = percentile(lat, 95)
    console.log(`[smoke] exec n=${N} mean=${mean.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${lat[lat.length - 1].toFixed(1)}ms`)
    expect(mean).toBeLessThan(250)
    expect(p95).toBeLessThan(500)
  }, 60_000)

  it('execute 超时 kill 真 daemon 证据（评审 M2：挂起命令 ~1s 处被 KILL，exitCode 124）', async () => {
    const primitives = new DockerPrimitives()
    const t0 = performance.now()
    const r = await primitives.exec(LAB, ['/bin/sh', '-c', 'sleep 30'], { timeoutMs: 800 })
    const elapsed = performance.now() - t0
    expect(r.exitCode).toBe(124)
    expect(r.stderr).toContain('timed out after 800ms')
    expect(elapsed).toBeLessThan(15_000) // 30s 命令被秒杀路径：必须远早于自然结束
  }, 30_000)
})
