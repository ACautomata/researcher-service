// wiki 容器 create options 纯逻辑单测（#784 · S2；buildWikiCreateOptions 不调 daemon 直锁形状）。
// #747 E 节 wiki 列安全/资源规格逐项断言：非 root / CapDrop ALL / no-new-privileges /
// Memory 256MB·PidsLimit 128 / NetworkMode none 零出网 / RestartPolicy unless-stopped（永久）/
// 无宿主端口 / 无 env / kind=wiki + owner 标签（对 fleet 隐身）/ 保活命令 / 零初始化（无骨架）。

import { describe, it, expect } from 'vitest'
import { DockerWikiContainerRuntime } from '../src/wikiContainers/dockerRuntime'
import { wikiContainerName, wikiRestoreImageRef } from '../src/wikiContainers/runtime'
import { WIKI_LIMITS, WIKI_ROOT } from '../src/wikiContainers/values'
import { KIND_WIKI, LABEL_KIND_KEY, LABEL_OWNER_KEY } from '../src/containers/constants'

const SPEC = { ownerId: 'cuser0001', image: 'busybox:1.36', limits: WIKI_LIMITS }

describe('wiki 容器命名单一来源（#747 E 节路径命名）', () => {
  it('容器名 researcher-wiki-<userId>；还原镜像引用 repo:ownerId', () => {
    expect(wikiContainerName('cuser0001')).toBe('researcher-wiki-cuser0001')
    expect(wikiRestoreImageRef('cuser0001')).toBe('researcher-wiki-restore:cuser0001')
  })

  it('树根常量 = /wiki（E 节「可写层 /wiki」）', () => {
    expect(WIKI_ROOT).toBe('/wiki')
  })
})

describe('buildWikiCreateOptions（#747 E 节 wiki 列投影）', () => {
  const rt = new DockerWikiContainerRuntime(() => null as never)
  const opts = rt.buildWikiCreateOptions(SPEC)

  it('镜像 + docker 名 + 保活命令（活性 = inspect Running 的 PID 1 前提）', () => {
    expect(opts.Image).toBe('busybox:1.36')
    expect(opts.name).toBe('researcher-wiki-cuser0001')
    expect(opts.Cmd).toEqual(['tail', '-f', '/dev/null'])
  })

  it('非 root（uid 1000 数值身份）', () => {
    expect(opts.User).toBe('1000:1000')
  })

  it('标签：kind=wiki + owner 绑定；不打 fleet app 标签（对容器列表隐身）', () => {
    expect(opts.Labels).toMatchObject({
      [LABEL_KIND_KEY]: KIND_WIKI,
      [LABEL_OWNER_KEY]: 'cuser0001',
    })
  })

  it('安全 profile：CapDrop ALL + no-new-privileges', () => {
    expect(opts.HostConfig?.CapDrop).toEqual(['ALL'])
    expect(opts.HostConfig?.SecurityOpt).toEqual(['no-new-privileges'])
  })

  it('资源 limit：Memory 256MB / PidsLimit 128（spec 初值）；MemorySwap=Memory 禁 swap；无 CPU 配额（规格未列）', () => {
    expect(opts.HostConfig?.Memory).toBe(256 * 1024 * 1024)
    expect(opts.HostConfig?.MemorySwap).toBe(256 * 1024 * 1024)
    expect(opts.HostConfig?.PidsLimit).toBe(128)
    expect(opts.HostConfig?.NanoCpus).toBeUndefined()
  })

  it('NetworkMode none：零出网（无网卡无 NAT；沙箱式独立 bridge 与之刻意分野）', () => {
    expect(opts.HostConfig?.NetworkMode).toBe('none')
  })

  it('RestartPolicy unless-stopped：永久容器 daemon 重启自愈（随用户生命周期，删除面归 removeWiki）', () => {
    expect(opts.HostConfig?.RestartPolicy).toEqual({ Name: 'unless-stopped' })
  })

  it('无 Tmpfs、无宿主端口、无 env 注入（busybox 纯文件仓库；OPENCLAW_*/GATEWAY_TOKEN/LLM_API_KEY 退役面）', () => {
    expect(opts.HostConfig?.Tmpfs).toBeUndefined()
    expect(opts.HostConfig?.PortBindings).toBeUndefined()
    expect(opts.ExposedPorts).toBeUndefined()
    expect(opts.Env).toBeUndefined()
  })

  it('不设 ReadonlyRootfs、不挂任何卷（E 节三取二取舍锁死：/wiki 驻容器可写层是 docker export 备份通道的前提；取舍论证见 dockerRuntime.ts 注释）', () => {
    expect(opts.HostConfig?.ReadonlyRootfs).toBeUndefined()
    expect(opts.HostConfig?.Binds).toBeUndefined()
  })

  it('limits 经 spec 参数注入（smoke/校准覆盖，不与常量耦合）', () => {
    const small = rt.buildWikiCreateOptions({
      ...SPEC,
      limits: { memoryBytes: 64 * 1024 * 1024, pidsLimit: 16 },
    })
    expect(small.HostConfig?.Memory).toBe(64 * 1024 * 1024)
    expect(small.HostConfig?.PidsLimit).toBe(16)
  })
})
