// DockerSandboxRuntime —— SandboxRuntime 的 dockerode 适配层（#776 · S2）。
// buildSandboxCreateOptions 是纯逻辑 seam（不调 daemon，单测直锁 #747 E 节安全/资源规格）；
// create/get/start/stop/remove/list 经 docker client。client 延迟注入（默认 new Docker() 挂
// docker.sock）——构造时不连 daemon（对齐 DockerRuntime / DockerFileArchive 先例）。
//
// /lab 属主预置：容器以 uid 1000 跑，根文件系统属 root——创建流程 putArchive 一个 uid/gid 1000、
// mode 0755 的 /lab 目录条目（daemon 应用 tar 头属主，同 seedWorkspace chown 语义），agent 进程
// 才能写自己的树。putArchive 对 created（未启动）容器可用，故在 start 前完成。

import Docker from 'dockerode'
import { Readable } from 'node:stream'
import { ensureImagePulled } from '../containers/dockerImage'
import { KIND_SANDBOX, LABEL_KIND_KEY, LABEL_SESSION_KEY } from '../containers/constants'
import { createTarTree } from '../files/tar'
import { SANDBOX_KEEPALIVE_CMD, SANDBOX_LAB_ROOT, SANDBOX_USER } from './values'
import {
  sandboxContainerName,
  sandboxNetworkName,
  sandboxFsImageName,
  type SandboxInfo,
  type SandboxRuntime,
  type SandboxSpec,
  type SandboxForkSpec,
} from './runtime'

// 网络与沙箱容器共用的标签（daemon 侧按 kind=sandbox 认领整个沙箱族，session 标签定归属）
function sandboxLabels(sessionId: string): Record<string, string> {
  return { [LABEL_KIND_KEY]: KIND_SANDBOX, [LABEL_SESSION_KEY]: sessionId }
}

// dockerode 错误携带的 HTTP 状态码（幂等吞错判定：409 已存在 / 404 不存在 / 304 已是目标态）
function statusCodeOf(e: unknown): number | undefined {
  return (e as { statusCode?: number }).statusCode
}

export class DockerSandboxRuntime implements SandboxRuntime {
  private cached: Docker | null = null

  constructor(private readonly clientFactory: () => Docker = () => new Docker()) {}

  private client(): Docker {
    if (this.cached === null) this.cached = this.clientFactory()
    return this.cached
  }

  // 构造沙箱 create 参数（纯逻辑，可单测）。#747 E 节沙箱列的完整投影：
  //  - 非 root（User 1000:1000）+ CapDrop ALL + no-new-privileges
  //  - RestartPolicy no（生命周期归 runner，不随 daemon 重启复活）
  //  - Memory 4GB / 4 核 / PidsLimit 512（spec 初值，spec 参数注入）；MemorySwap=Memory 禁 swap
  //   （OOM 杀进程语义的前提：swap 不设时限内内存可落交换分区绕开 cgroup 杀）
  //  - /tmp tmpfs + 可写层 /lab（无 named volume）
  //  - 每沙箱独立 bridge 网络（容器间零互通；出网 NAT 放行）
  //  - 无宿主端口 / 无 env 注入（OPENCLAW_*/GATEWAY_TOKEN/LLM_API_KEY 全面退役）
  //  - kind=sandbox + session 标签（不打 app=openclaw-fleet → 对 fleet 列表/端口对账隐身）
  //
  // ReadonlyRootfs 的显式取舍（规格 E 节「只读根 + /tmp tmpfs + 可写层 /lab」三约束在 Docker
  // 语义下互斥）：ReadonlyRootfs:true 时容器 rootfs 整体 ro-mount——/lab 要可写必须挂卷或 tmpfs，
  // 但规格钉死「无具名卷」、tmpfs 不跨 stop 保留（story 58「闲置 stop 文件保留」硬约束）；
  // 且 rewind 墓碑目录（attic，#766 D8「daemon 侧 root 写容器内 0700 隐藏目录」）同样落容器
  // rootfs——daemon putArchive 对 ro rootfs 同样 EROFS。
  //
  // 匿名卷（Binds: ['/lab']，非具名）看似可同时满足四项（只读根+可写+跨 stop 保留+非具名），
  // 不选的真实代价：(1) 卷生命周期独立于容器——remove 必须显式 -v 才随之销毁，否则残留孤儿卷，
  // 而本票语义是「删会话级联销毁文件」（#776 级联删），该保证将从容器的单点生命周期降级为
  // 调用方记得 -v 的纪律；(2) 匿名卷首挂时 daemon 以镜像内 /lab 内容初始化（busybox 无 /lab
  // → 建空目录 root 属主），/lab 属主预置（下方 putArchive）将与卷初始化顺序纠缠。
  //
  // 三取二下保「文件保留 + 无具名卷」，只读根让位（敢写越界的结构性兜底由规则层路径白名单
  // lab/** tmp/** + 审批漏斗承担，#747 D 节；镜像内容防篡改面收敛：busybox 级镜像内
  // world-writable 面积极小，uid 1000 不可写 root 目录）。取舍为对 E 节明文的偏离，
  // #784 wiki 容器同款三约束，规格侧修订随其追认。
  buildSandboxCreateOptions(spec: SandboxSpec): Docker.ContainerCreateOptions {
    return {
      Image: spec.image,
      name: sandboxContainerName(spec.sessionId),
      Cmd: [...SANDBOX_KEEPALIVE_CMD],
      User: SANDBOX_USER,
      Labels: sandboxLabels(spec.sessionId),
      HostConfig: {
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Memory: spec.limits.memoryBytes,
        // MemorySwap = Memory：禁 swap——否则超限内存落交换分区绕开 OOM 杀进程语义
        //（story 59「内存超限 OOM 杀进程不杀容器」的前提；防失控进程拖垮宿主盘 IO 顺带成立）
        MemorySwap: spec.limits.memoryBytes,
        NanoCpus: spec.limits.nanoCpus,
        PidsLimit: spec.limits.pidsLimit,
        RestartPolicy: { Name: 'no' },
        Tmpfs: { '/tmp': '' },
        NetworkMode: sandboxNetworkName(spec.sessionId),
      },
    }
  }

  // 创建前置：镜像本地就位（缺失则 pull）。实现细节不进 Port——沙箱侧无 fleet #699 升级式的
  // 外部 ensureImage 消费点（createSandbox 内部兜住）；#784 若出现再加回接口。
  private async ensureImage(image: string): Promise<void> {
    await ensureImagePulled(this.client(), image)
  }

  async createNetwork(sessionId: string): Promise<void> {
    try {
      await this.client().createNetwork({ Name: sandboxNetworkName(sessionId), Labels: sandboxLabels(sessionId) })
    } catch (e) {
      // 已存在（外部残留/上一轮清理中断）→ 幂等复用
      if (statusCodeOf(e) !== 409) throw e
    }
  }

  async removeNetwork(sessionId: string): Promise<void> {
    try {
      await this.client().getNetwork(sandboxNetworkName(sessionId)).remove()
    } catch (e) {
      if (statusCodeOf(e) !== 404) throw e
    }
  }

  // 创建（不启动）：ensureImage → createContainer → putArchive 预置 /lab 属主。
  // 网络创建是业务编排（lifecycle.ensure 显式先行），不在本原语内。
  async createSandbox(spec: SandboxSpec): Promise<string> {
    await this.ensureImage(spec.image)
    const container = await this.client().createContainer(this.buildSandboxCreateOptions(spec))
    // /lab 目录条目名由树根常量派生（'lab'），防路径字面量手写漂移
    await container.putArchive(
      Readable.from([
        createTarTree([{ name: SANDBOX_LAB_ROOT.slice(1), type: 'directory', modeOctal: '0000755' }]),
      ]),
      { path: '/', chown: true }, // 应用 tar 头 uid/gid 1000（同 seedWorkspace 语义）
    )
    return container.id
  }

  // fork 字面复制（#768 D7）：export（容器可写层 + 镜像层的整 FS tar 流，含 /lab、墓碑目录与
  // exec 装的包）→ import 为目标专属镜像（单层；repo/tag 由 sandboxFsImageName 单一来源派生，
  // 随 removeSandbox 顺手回收）。源已删（404）→ 'source-missing'。export 对 stopped 容器同样
  // 可用（闲置 stop 文件保留语义的直接受益面）；fork 门禁挡 run 进行中 → 导出无并发写。
  // /lab 属主预置（createSandbox 的 putArchive）不适用——源 tar 里已带全部属主信息，import
  // 原样落盘（「字面」语义的字节面）。
  async createSandboxFromSource(spec: SandboxForkSpec): Promise<'copied' | 'source-missing'> {
    try {
      await this.client().getContainer(sandboxContainerName(spec.sourceSessionId)).inspect()
    } catch (e) {
      if (statusCodeOf(e) === 404) return 'source-missing'
      throw e
    }
    const fsImage = sandboxFsImageName(spec.sessionId)
    const stream = await this.client().getContainer(sandboxContainerName(spec.sourceSessionId)).export()
    await this.client().importImage(stream, { repo: fsImage, tag: 'latest' })
    await this.client().createContainer(this.buildSandboxCreateOptions({ ...spec, image: fsImage }))
    return 'copied'
  }

  async getSandbox(sessionId: string): Promise<SandboxInfo | null> {
    try {
      const data = await this.client().getContainer(sandboxContainerName(sessionId)).inspect()
      return this.inspectToInfo(data)
    } catch (e) {
      if (statusCodeOf(e) === 404) return null
      throw e
    }
  }

  async startSandbox(sessionId: string): Promise<void> {
    try {
      await this.client().getContainer(sandboxContainerName(sessionId)).start()
    } catch (e) {
      const sc = statusCodeOf(e)
      if (sc === 404 || sc === 304) return // 不存在 / 已 running：幂等
      throw e
    }
  }

  async stopSandbox(sessionId: string): Promise<void> {
    try {
      await this.client().getContainer(sandboxContainerName(sessionId)).stop({ t: 1 })
    } catch (e) {
      const sc = statusCodeOf(e)
      if (sc === 404 || sc === 304) return // 不存在 / 已停：幂等（对齐 DockerRuntime.stop）
      throw e
    }
  }

  async removeSandbox(sessionId: string): Promise<void> {
    try {
      await this.client().getContainer(sandboxContainerName(sessionId)).remove({ force: true })
    } catch (e) {
      if (statusCodeOf(e) !== 404) throw e
    }
    // fork 导入镜像随容器回收（尽力：常规沙箱无此镜像 → 404 吞；daemon 故障不阻断删除主链）
    try {
      await this.client().getImage(sandboxFsImageName(sessionId)).remove()
    } catch {
      // 镜像清理是 best-effort——容器已删，残留镜像不影响语义（标签唯一，可被外部 GC）
    }
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    const cs = await this.client().listContainers({
      all: true,
      filters: { label: [`${LABEL_KIND_KEY}=${KIND_SANDBOX}`] },
    })
    return cs
      .map((c) => this.listItemToInfo(c))
      .filter((i): i is SandboxInfo => i !== null)
  }

  private toInfoCommon(containerId: string, running: boolean, status: string, image: string, labels: Record<string, string>): SandboxInfo | null {
    const sessionId = labels[LABEL_SESSION_KEY]
    if (sessionId === undefined) return null // 无 session 标签的容器不属沙箱编排（防御）
    return { containerId, sessionId, running, status, image }
  }

  private inspectToInfo(data: Docker.ContainerInspectInfo): SandboxInfo | null {
    return this.toInfoCommon(
      data.Id,
      data.State?.Status === 'running',
      data.State?.Status ?? '',
      data.Config?.Image ?? '',
      data.Config?.Labels ?? {},
    )
  }

  private listItemToInfo(c: Docker.ContainerInfo): SandboxInfo | null {
    return this.toInfoCommon(c.Id, c.State === 'running', c.State ?? '', c.Image ?? '', c.Labels ?? {})
  }
}
