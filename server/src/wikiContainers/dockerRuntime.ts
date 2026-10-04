// DockerWikiContainerRuntime —— WikiContainerRuntime 的 dockerode 适配层（#784 · S2）。
// buildWikiCreateOptions 是纯逻辑 seam（不调 daemon，单测直锁 #747 E 节 wiki 列安全/资源规格）；
// create/get/start/remove/list/export/import 经 docker client。client 延迟注入（默认 new
// Docker() 挂 docker.sock）——构造时不连 daemon（对齐 DockerSandboxRuntime 先例）。
//
// /wiki 属主预置：容器以 uid 1000 跑，根文件系统属 root——创建流程 putArchive 一个 uid/gid
// 1000、mode 0755 的 /wiki 目录条目（daemon 应用 tar 头属主，同沙箱 /lab 预置语义），agent
// 写工具与 wiki REST 写面才能落自己的树。**零初始化**：仅属主预置，无任何骨架 COPY（E 节
// 「OpenWiki 按需生成；现状骨架 COPY 废止」——空 /wiki 是新形态的合法初态，wiki REST 空树
// 降级、agent 工具按需生成）。
//
// ReadonlyRootfs 的显式取舍（沙箱同款三约束互斥，注释即契约）：E 节「只读根 + 可写层 /wiki +
// 无具名卷」在 Docker 语义下三取二——ReadonlyRootfs:true 时 /wiki 可写必须挂卷，而「无具名卷」
// 钉死 + 备份通道 = docker export（export 不含卷内容，/wiki 落卷即备份失明），且永久容器的
// 文件必须驻留容器可写层。故保「可写层 /wiki + 无具名卷 + docker export 备份」，只读根让位
//（越界写兜底 = 镜像 world-writable 面积极小 + busybox 无运行时 + 规则层路径白名单，#747 D 节；
// 规格侧修订随本票追认）。

import Docker from 'dockerode'
import { Readable } from 'node:stream'
import { ensureImagePulled } from '../containers/dockerImage'
import { KIND_WIKI, LABEL_KIND_KEY, LABEL_OWNER_KEY } from '../containers/constants'
import { containerKind } from '../containers/kind'
import { createTarTree } from '../files/tar'
import { WIKI_KEEPALIVE_CMD, WIKI_ROOT, WIKI_USER } from './values'
import {
  WIKI_RESTORE_REPO,
  wikiContainerName,
  wikiRestoreImageRef,
  type WikiContainerInfo,
  type WikiContainerRuntime,
  type WikiContainerSpec,
} from './runtime'

// wiki 容器标签（daemon 侧按 kind=wiki 认领，owner 标签定归属——不打 app=openclaw-fleet，
// 对 fleet 列表/端口对账天然隐身，沙箱同款）
function wikiLabels(ownerId: string): Record<string, string> {
  return { [LABEL_KIND_KEY]: KIND_WIKI, [LABEL_OWNER_KEY]: ownerId }
}

// dockerode 错误携带的 HTTP 状态码（幂等吞错判定：404 不存在 / 304 已是目标态）
function statusCodeOf(e: unknown): number | undefined {
  return (e as { statusCode?: number }).statusCode
}

// docker export 全树 tar 收集护栏：wiki 库正常几 MB 量级，护栏只防失控 daemon 流（对齐
// DockerPrimitives.getArchive 口径），不是 wiki 容量配额（E 节无容量列；超限 = 运维显式介入面）。
const EXPORT_MAX_BYTES = 512 * 1024 * 1024

export class DockerWikiContainerRuntime implements WikiContainerRuntime {
  private cached: Docker | null = null

  constructor(private readonly clientFactory: () => Docker = () => new Docker()) {}

  private client(): Docker {
    if (this.cached === null) this.cached = this.clientFactory()
    return this.cached
  }

  // 构造 wiki 容器 create 参数（纯逻辑，可单测）。#747 E 节 wiki 列的完整投影：
  //  - 非 root（User 1000:1000）+ CapDrop ALL + no-new-privileges
  //  - Memory 256MB / PidsLimit 128（规格初值，spec 参数注入）；MemorySwap = Memory 禁 swap
  //   （沙箱同款：超限内存绕开 cgroup 杀的口子不留给任何容器）
  //  - NetworkMode none：零出网（无网卡无 NAT，零网络对象——独立于沙箱「独立 bridge」：
  //   wiki 容器是纯文件仓库，无任何出网/互通需求，none 是最强网络面）
  //  - RestartPolicy unless-stopped：**永久容器**（随用户生命周期）——daemon 重启自愈，
  //   不依赖控制面在线 re-ensure；删除面（removeWiki）显式 remove 与重启策略不冲突
  //  - 无 Tmpfs / 无宿主端口 / 无 env 注入（busybox 纯文件仓库，无运行时需求）
  //  - kind=wiki + owner 标签（对 fleet 列表隐身）
  buildWikiCreateOptions(spec: WikiContainerSpec): Docker.ContainerCreateOptions {
    return {
      Image: spec.image,
      name: wikiContainerName(spec.ownerId),
      Cmd: [...WIKI_KEEPALIVE_CMD],
      User: WIKI_USER,
      Labels: wikiLabels(spec.ownerId),
      HostConfig: {
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Memory: spec.limits.memoryBytes,
        MemorySwap: spec.limits.memoryBytes, // 禁 swap（沙箱同款 OOM 语义前提）
        PidsLimit: spec.limits.pidsLimit,
        RestartPolicy: { Name: 'unless-stopped' },
        NetworkMode: 'none',
      },
    }
  }

  // 创建前置：镜像本地就位（缺失则 pull）。实现细节不进 Port（沙箱同款：无外部 ensureImage
  // 消费点，createWiki 内部兜住）。
  private async ensureImage(image: string): Promise<void> {
    await ensureImagePulled(this.client(), image)
  }

  // 创建（不启动）：ensureImage → createContainer → putArchive 预置 /wiki 属主（零初始化）。
  async createWiki(spec: WikiContainerSpec): Promise<string> {
    await this.ensureImage(spec.image)
    const container = await this.client().createContainer(this.buildWikiCreateOptions(spec))
    // /wiki 目录条目名由树根常量派生（'wiki'），防路径字面量手写漂移
    await container.putArchive(
      Readable.from([
        createTarTree([{ name: WIKI_ROOT.slice(1), type: 'directory', modeOctal: '0000755' }]),
      ]),
      { path: '/', chown: true }, // 应用 tar 头 uid/gid 1000（沙箱 /lab 预置同语义）
    )
    return container.id
  }

  async getWiki(ownerId: string): Promise<WikiContainerInfo | null> {
    try {
      const data = await this.client().getContainer(wikiContainerName(ownerId)).inspect()
      return this.inspectToInfo(data)
    } catch (e) {
      if (statusCodeOf(e) === 404) return null
      throw e
    }
  }

  async startWiki(ownerId: string): Promise<void> {
    try {
      await this.client().getContainer(wikiContainerName(ownerId)).start()
    } catch (e) {
      const sc = statusCodeOf(e)
      if (sc === 404 || sc === 304) return // 不存在 / 已 running：幂等
      throw e
    }
  }

  async removeWiki(ownerId: string): Promise<void> {
    try {
      await this.client().getContainer(wikiContainerName(ownerId)).remove({ force: true })
    } catch (e) {
      if (statusCodeOf(e) !== 404) throw e
    }
  }

  // docker export 全树 tar（容器文件系统整体——含可写层 /wiki 与镜像层合并视图）。
  // stopped 容器同样可 export（daemon 原语，无进程依赖）。
  async exportWiki(ownerId: string): Promise<Buffer> {
    const stream = await this.client().getContainer(wikiContainerName(ownerId)).export()
    const parts: Buffer[] = []
    let total = 0
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += chunk.length
      if (total > EXPORT_MAX_BYTES) throw new Error(`exportWiki exceeds guard (${EXPORT_MAX_BYTES} bytes)`)
      parts.push(chunk)
    }
    return Buffer.concat(parts)
  }

  // docker import 全树 tar → 还原镜像。固定 repo + tag=ownerId 复用覆盖；返回镜像引用供
  // lifecycle.restore 以 createWiki(spec{image: 引用}) 重建容器。只建镜像不动容器。
  async importWiki(ownerId: string, tar: Buffer): Promise<string> {
    const stream = await this.client().importImage(Readable.from([tar]), {
      repo: WIKI_RESTORE_REPO,
      tag: ownerId,
    })
    for await (const _ of stream as AsyncIterable<unknown>) {
      void _ // import 应答为 JSON status 行，消费即弃（失败经后续 create/start 暴露）
    }
    return wikiRestoreImageRef(ownerId)
  }

  // —— inspect → info 映射（防御性识别，containers/kind.ts containerKind 消费点）：派生名上的
  // 容器 kind ≠ wiki（外来同名容器/标签漂移）或 owner 标签缺失 → 非本编排资产——getWiki 返
  // null（ensure 会走 create 并因名字冲突 loud fail），remove 不误删。沙箱 toInfoCommon 同构。

  private toInfoCommon(
    containerId: string,
    running: boolean,
    status: string,
    image: string,
    labels: Record<string, string>,
  ): WikiContainerInfo | null {
    if (containerKind(labels) !== 'wiki') return null
    const ownerId = labels[LABEL_OWNER_KEY]
    if (ownerId === undefined) return null
    return { containerId, ownerId, running, status, image }
  }

  private inspectToInfo(data: Docker.ContainerInspectInfo): WikiContainerInfo | null {
    return this.toInfoCommon(
      data.Id,
      data.State?.Status === 'running',
      data.State?.Status ?? '',
      data.Config?.Image ?? '',
      data.Config?.Labels ?? {},
    )
  }
}
