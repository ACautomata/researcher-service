// WikiContainerLifecycle 单测（#784 · S2「编排器 Port 延伸」：注入 FakeWikiContainerRuntime）。
// 验收面：ensure 幂等（running 不重建 / stopped 复启文件保留 / 不存在零初始化创建）、
// remove（幂等 not-found；无网络清理面）、backup/restore 编排（import → remove → create →
// start）、per-owner 并发 ensure 单次落地、create 失败可重试。

import { describe, it, expect } from 'vitest'
import { WikiContainerLifecycle } from '../src/wikiContainers/lifecycle'
import { FakeWikiContainerRuntime } from './fakeWikiContainerRuntime'
import { WIKI_LIMITS } from '../src/wikiContainers/values'

function makeLifecycle(opts: { image?: string } = {}) {
  const runtime = new FakeWikiContainerRuntime()
  const lifecycle = new WikiContainerLifecycle(runtime, {
    image: opts.image ?? 'busybox:1.36',
  })
  return { runtime, lifecycle }
}

const OWNER = 'cuser0001'

describe('wiki 容器 ensure（kind=wiki 的 create/health 合一面）', () => {
  it('不存在 → create（零初始化）+ start 并返回 running 快照；时序 createWiki → startWiki', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    const info = await lifecycle.ensure(OWNER)
    expect(info).toMatchObject({ ownerId: OWNER, running: true, image: 'busybox:1.36' })
    expect(runtime.containers.has(OWNER)).toBe(true)
    expect(runtime.calls.map((c) => c.kind)).toEqual(['createWiki', 'startWiki'])
  })

  it('spec 透传：镜像 + limits（缺省规格初值 / 覆盖值生效）', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    await lifecycle.ensure(OWNER)
    expect(runtime.containers.get(OWNER)?.spec).toMatchObject({
      ownerId: OWNER,
      image: 'busybox:1.36',
      limits: WIKI_LIMITS,
    })
    const rt2 = new FakeWikiContainerRuntime()
    const lc2 = new WikiContainerLifecycle(rt2, {
      image: 'img:test',
      limits: { memoryBytes: 1, pidsLimit: 3 },
    })
    await lc2.ensure('cuser0002')
    expect(rt2.containers.get('cuser0002')?.spec.limits).toEqual({ memoryBytes: 1, pidsLimit: 3 })
  })

  it('已 running → 幂等返回，不重建不复启', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    await lifecycle.ensure(OWNER)
    const first = runtime.containers.get(OWNER)!.info.containerId
    runtime.calls.length = 0
    const again = await lifecycle.ensure(OWNER)
    expect(again.containerId).toBe(first)
    expect(runtime.calls).toEqual([]) // get 命中即返
  })

  it('stopped（daemon 重启后未自愈/外部 stop）→ 复启，容器不重建（可写层 /wiki 文件保留语义）', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    await lifecycle.ensure(OWNER)
    const first = runtime.containers.get(OWNER)!.info.containerId
    // 模拟外部 stop（fake 无 stopWiki 原语——直接改状态，语义等同 daemon 侧 stopped）
    const rec = runtime.containers.get(OWNER)!
    rec.info = { ...rec.info, running: false, status: 'exited' }
    const info = await lifecycle.ensure(OWNER)
    expect(info.containerId).toBe(first) // 同一容器——/wiki 跨 stop/start 存续
    expect(runtime.calls.at(-1)?.kind).toBe('startWiki')
  })

  it('并发 ensure 同 owner → 单次落地（per-owner 串行）', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    await Promise.all([lifecycle.ensure(OWNER), lifecycle.ensure(OWNER), lifecycle.ensure(OWNER)])
    expect(runtime.calls.filter((c) => c.kind === 'createWiki')).toHaveLength(1)
  })

  it('create 失败可重试（不落半态）', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    runtime.failCreateFor.add(OWNER)
    await expect(lifecycle.ensure(OWNER)).rejects.toThrow('simulated wiki create failure')
    runtime.failCreateFor.delete(OWNER)
    await expect(lifecycle.ensure(OWNER)).resolves.toMatchObject({ running: true })
  })
})

describe('wiki 容器 remove（kind=wiki 的 delete 面：用户级联删 / T0 清理）', () => {
  it('存在 → 删除返回 removed；再删幂等 not-found（级联链安全重试）', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    await lifecycle.ensure(OWNER)
    expect(await lifecycle.remove(OWNER)).toBe('removed')
    expect(runtime.containers.has(OWNER)).toBe(false)
    expect(await lifecycle.remove(OWNER)).toBe('not-found')
  })

  it('无网络清理调用（NetworkMode none：无网络对象——分派面与沙箱 delete 的刻意差异）', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    await lifecycle.ensure(OWNER)
    await lifecycle.remove(OWNER)
    expect(runtime.calls.filter((c) => c.kind.startsWith('remove'))).toEqual([
      { kind: 'removeWiki', ownerId: OWNER },
    ])
  })
})

describe('backup / restore（#747 E 节「备份 = docker export 全树 tar」唯一持久性出口）', () => {
  it('backup → runtime.exportWiki 全树 tar 原样透传', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    await lifecycle.ensure(OWNER)
    const tar = Buffer.from('fake-full-tree-tar')
    runtime.exportBytes.set(OWNER, tar)
    expect(await lifecycle.backup(OWNER)).toBe(tar)
    expect(runtime.exports).toEqual([OWNER])
  })

  it('restore 编排：importWiki → removeWiki（旧容器）→ createWiki（还原镜像）→ startWiki', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    await lifecycle.ensure(OWNER)
    runtime.calls.length = 0
    const tar = Buffer.from('fake-full-tree-tar')
    const info = await lifecycle.restore(OWNER, tar)
    expect(runtime.imports).toEqual([{ ownerId: OWNER, tar }])
    expect(runtime.calls.map((c) => c.kind)).toEqual(['importWiki', 'removeWiki', 'createWiki', 'startWiki'])
    // 重建容器以还原镜像起（wikiContainerName 派生 + restore 镜像 ref）
    expect(info).toMatchObject({ ownerId: OWNER, running: true, image: 'researcher-wiki-restore:cuser0001' })
    expect(runtime.containers.get(OWNER)?.spec.image).toBe('researcher-wiki-restore:cuser0001')
  })

  it('restore 对不存在的容器同样成立（无旧容器可删，remove 幂等跳过）', async () => {
    const { runtime, lifecycle } = makeLifecycle()
    const info = await lifecycle.restore(OWNER, Buffer.from('tar'))
    expect(runtime.calls.map((c) => c.kind)).toEqual(['importWiki', 'removeWiki', 'createWiki', 'startWiki'])
    expect(info.running).toBe(true)
  })
})
