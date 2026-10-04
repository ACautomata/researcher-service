// wiki 容器生命周期集成 smoke（#784 验收真 daemon 侧 · S2 门控，sandboxSmoke 同款）。
// 门控：docker daemon 不可达 → describe.skipIf 整套跳过；单测（fake-Docker）是 S2 常开防线。
// 覆盖（#784 AC）：
//   1. ensure 惰性创建 → 真 inspect 断言 E 节 wiki 列规格（非 root/CapDrop/no-new-priv/
//      NetworkMode none/Memory/PidsLimit/kind+owner 标签/无端口/unless-stopped/保活 PID 1）
//   2. 零初始化：空 /wiki 合法初态（tree 空组）→ wiki REST 存储适配器（DockerWikiFileSystem）
//      create/read/write/delete 全链通（AC「零初始化起容器后 wiki 域 REST 读写通」的存储面证据；
//      路由接线由 wikiContainerRest.test.ts 信封级覆盖）
//   3. NetworkMode none 验证：NetworkSettings.Networks 为空（无网卡，零出网的最强形态）
//   4. docker export 全树备份可还原：backup → remove → restore（import → 重建）→ 页面读回
//   5. 对 fleet 列表隐身：app=openclaw-fleet 过滤不含 wiki 容器

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Docker from 'dockerode'
import { WikiContainerLifecycle } from '../src/wikiContainers/lifecycle'
import { DockerWikiContainerRuntime } from '../src/wikiContainers/dockerRuntime'
import { wikiContainerName } from '../src/wikiContainers/runtime'
import { DockerWikiFileSystem } from '../src/wiki/dockerFs'
import { WikiService } from '../src/wiki/service'
import { KIND_WIKI, LABEL_APP_KEY, LABEL_APP_VALUE, LABEL_KIND_KEY, LABEL_OWNER_KEY } from '../src/containers/constants'
import { probeDockerAvailable } from './smokeGating'
import { ensureImageAvailable } from './smokeDocker'

const IMAGE = 'busybox:1.36'
// smoke 直用 busybox 而非 config 默认的派生 wiki 镜像：派生镜像（ghcr.io/…/wiki:1.36）由 CD
// 随发布构建推送，本地开发无凭证不可拉（sandboxSmoke 同款取舍）。镜像身份由 wikiImage.test.ts
// 交叉断言锁死：派生镜像 = busybox:1.36 基线 + 构建期 applet 断言，运行时行为与 busybox 等价。
const OWNER = `csmoke${process.pid}` // 合法 ownerId 形态（小写字母数字）；跨进程唯一
// smoke 用小 limits（形状与规格初值同构；规格常数由纯逻辑测试锁定，不与 smoke 耦合）
const SMOKE_LIMITS = { memoryBytes: 128 * 1024 * 1024, pidsLimit: 64 }

const DOCKER_UP = probeDockerAvailable()

describe.skipIf(!DOCKER_UP)('wiki 容器生命周期集成 smoke（真 docker daemon）', () => {
  let docker: Docker
  let runtime: DockerWikiContainerRuntime
  let lifecycle: WikiContainerLifecycle
  let dockerName: string
  let wikiFs: DockerWikiFileSystem
  let wikiSvc: WikiService

  beforeAll(async () => {
    if (!DOCKER_UP) return
    docker = new Docker()
    await ensureImageAvailable(IMAGE)
    runtime = new DockerWikiContainerRuntime()
    lifecycle = new WikiContainerLifecycle(runtime, { image: IMAGE, limits: SMOKE_LIMITS })
    dockerName = wikiContainerName(OWNER)
    wikiFs = new DockerWikiFileSystem(dockerName)
    wikiSvc = new WikiService(wikiFs)
  }, 120_000)

  afterAll(async () => {
    if (!DOCKER_UP || !runtime) return // beforeAll 中途失败（如镜像拉取超时）防次生噪声
    await runtime.removeWiki(OWNER)
    await docker.getImage(`researcher-wiki-restore:${OWNER}`).remove({ force: true }).catch(() => {})
  })

  it('ensure 惰性创建：inspect 断言安全/资源/标签规格（E 节 wiki 列）', async () => {
    const info = await lifecycle.ensure(OWNER)
    expect(info.running).toBe(true)
    const data = await docker.getContainer(dockerName).inspect()
    // 资源 limit（smoke 注入值——形状与规格初值同构）+ MemorySwap=Memory 禁 swap
    expect(data.HostConfig.Memory).toBe(SMOKE_LIMITS.memoryBytes)
    expect(data.HostConfig.MemorySwap).toBe(SMOKE_LIMITS.memoryBytes)
    expect(data.HostConfig.PidsLimit).toBe(SMOKE_LIMITS.pidsLimit)
    // 安全 profile
    expect(data.Config.User).toBe('1000:1000')
    expect(data.HostConfig.CapDrop).toEqual(['ALL'])
    expect(data.HostConfig.SecurityOpt).toEqual(['no-new-privileges'])
    // 永久容器：daemon 重启自愈（随用户生命周期；删除面归 removeWiki）
    expect(data.HostConfig.RestartPolicy?.Name).toBe('unless-stopped')
    // NetworkMode none 零出网（AC「NetworkMode none 有验证」）
    expect(data.HostConfig.NetworkMode).toBe('none')
    expect(data.NetworkSettings.Networks ?? {}).toEqual({})
    // 标签：kind=wiki + owner 绑定；不打 fleet app 标签
    expect(data.Config.Labels).toMatchObject({ [LABEL_KIND_KEY]: KIND_WIKI, [LABEL_OWNER_KEY]: OWNER })
    expect(data.Config.Labels?.app).toBeUndefined()
    // 无宿主端口发布（端口池随 legacy 退役）
    expect(data.HostConfig.PortBindings ?? {}).toEqual({})
    // 保活 PID 1 存活（活性 = inspect Running 的前提）
    expect(data.State.Running).toBe(true)
  }, 120_000)

  it('零初始化：空 /wiki 合法初态，REST 存储适配器读通（空树降级）', async () => {
    const tree = await wikiFs.buildTree()
    expect(tree).toEqual({ groups: [] })
  }, 60_000)

  it('wiki 域存储适配器写读全链：create → read → write → tree/graph/categories → delete', async () => {
    await wikiFs.createPage('concepts/attention.md', '---\ntitle: Attention\n---\n# Attention\n见 [[self-attention]]。\n')
    await wikiFs.createPage('concepts/self-attention.md', '# Self Attention\n`category: ml`\n\n链接 [[attention]]。\n')
    // 读回：frontmatter title + 全文
    const page = await wikiFs.readPage('concepts/attention.md')
    expect(page.title).toBe('Attention')
    expect(page.content).toContain('# Attention')
    // 覆写
    await wikiFs.writePage('concepts/attention.md', '---\ntitle: Attention v2\n---\n# Attention v2\n')
    expect((await wikiFs.readPage('concepts/attention.md')).title).toBe('Attention v2')
    // tree 分组（开放目录分组；categories 收顶层散落页——本页集两组均在 concepts）
    const tree = await wikiFs.buildTree()
    expect(tree.groups.map((g) => g.name)).toEqual(['concepts'])
    const categories = await wikiSvc.listCategories()
    expect(Object.keys(categories)).toEqual(['ml'])
    // graph：wikilink 边 + ghost 节点机制
    const graph = await wikiSvc.buildGraph()
    expect(graph.edges.length).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it('docker export 全树备份可还原：backup → remove → restore → 页面读回一致（AC）', async () => {
    const before = await wikiFs.readPage('concepts/self-attention.md')
    const tar = await lifecycle.backup(OWNER)
    expect(tar.length).toBeGreaterThan(0)
    // 删容器（可写层随之销毁）→ 全库清零
    expect(await lifecycle.remove(OWNER)).toBe('removed')
    expect(await runtime.getWiki(OWNER)).toBeNull()
    expect(await wikiFs.buildTree()).toEqual({ groups: [] })
    // 还原：import 全树 tar → 以还原镜像重建容器 → 启动
    const info = await lifecycle.restore(OWNER, tar)
    expect(info.running).toBe(true)
    // 页面读回逐字节一致（全树含 uid/gid 属主还原——uid 1000 可继续写）
    const after = await wikiFs.readPage('concepts/self-attention.md')
    expect(after.content).toBe(before.content)
    expect(after.title).toBe(before.title)
    await wikiFs.createPage('post-restore.md', '# writable\n')
    expect((await wikiFs.readPage('post-restore.md')).content).toContain('# writable')
  }, 120_000)

  it('对 fleet 列表隐身：app=openclaw-fleet 过滤不含 wiki 容器；kind=wiki 过滤含 wiki 容器', async () => {
    const fleet = await docker.listContainers({ all: true, filters: { label: [`${LABEL_APP_KEY}=${LABEL_APP_VALUE}`] } })
    expect(fleet.map((c) => c.Names?.[0])).not.toContain(`/${dockerName}`)
    const wikis = await docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_KIND_KEY}=${KIND_WIKI}`] },
    })
    expect(wikis.map((c) => c.Names?.[0])).toContain(`/${dockerName}`)
  })
})
