// DockerRuntime —— dockerode 适配层（平移 backend/containers/docker_runtime.py，#334）。
// buildRunOptions 是纯逻辑 seam（不调 daemon），run/listFleet/get/stop/remove 经 docker client 操作 daemon。
// client 延迟注入（默认 new Docker() 挂 /var/run/docker.sock）——构造时不连 daemon，仅实际调用时才连。
// T0 #801 legacy 清退：宿主端口发布（PortBindings/ExposedPorts/port label）与 oneshot 升级编排
// （runOnce 全家）随端口池/upgrade 编排退役删除——容器 gateway 不再有外部连接方。

import Docker from 'dockerode'
import {
  GATEWAY_BIND,
  GATEWAY_INTERNAL_PORT,
  HOME_BIND,
  LABEL_APP_KEY,
  LABEL_APP_VALUE,
  LABEL_INSTANCE_KEY,
  MOUNT_WIKI,
  MOUNT_WORKSPACE,
} from './constants'
import {
  containerName,
  volumeOrder,
  type ContainerInfo,
  type ContainerRuntime,
  type ContainerSpec,
  type NamedVolumes,
} from './runtime'
import { ensureImagePulled } from './dockerImage'

// 4 个 sync flag 全关（防覆写挂载的 openclaw.json / 防明文写凭证；对官方镜像无害、兼容 fork init.sh）。
const SYNC_FLAGS_OFF: Record<string, string> = {
  SYNC_OPENCLAW_CONFIG: 'false',
  SYNC_EXTENSIONS_ON_START: 'false',
  SYNC_EXTENSIONS_MODE: 'none',
  SYNC_MODEL_CONFIG: 'false',
}

// 基础环境（locale + gateway 绑定 + 关闭外联 IM channel + 插件开关）
const BASE_ENV: Record<string, string> = {
  TZ: 'Asia/Shanghai',
  HOME: '/home/node',
  TERM: 'xterm-256color',
  NODE_ENV: 'production',
  LANG: 'en_US.UTF-8',
  LANGUAGE: 'en_US:en',
  LC_ALL: 'en_US.UTF-8',
  OPENCLAW_GATEWAY_PORT: String(GATEWAY_INTERNAL_PORT),
  OPENCLAW_GATEWAY_BIND: GATEWAY_BIND,
  OPENCLAW_GATEWAY_MODE: 'local',
  // openclaw.json 走镜像内默认（~/.openclaw/openclaw.json）——T0 起控制面不再渲染/写盘容器
  // config（ConfigRenderer 与模板随 legacy 清退退役），首启 gateway 读镜像默认配置。
  OPENCLAW_WORKSPACE_ROOT: HOME_BIND,
  DM_POLICY: 'disabled',
  GROUP_POLICY: 'disabled',
  ALLOW_FROM: '',
  OPENCLAW_PLUGINS_ENABLED: 'true',
}

function envRecordToArray(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`)
}

function panelEnv(): Record<string, string> {
  return { ...BASE_ENV, ...SYNC_FLAGS_OFF }
}

// named volume 挂载的唯一构造点（fleet 三卷）。
function volumeMount(source: string, target: string, readOnly = false): Docker.MountSettings {
  return { Type: 'volume', Source: source, Target: target, ...(readOnly ? { ReadOnly: true } : {}) }
}

export class DockerRuntime implements ContainerRuntime {
  private cached: Docker | null = null

  constructor(private readonly clientFactory: () => Docker = () => new Docker()) {}

  private client(): Docker {
    if (this.cached === null) this.cached = this.clientFactory()
    return this.cached
  }

  // 构造 docker create 参数（纯逻辑，可单测）。T0 #801：无 ExposedPorts/PortBindings——
  // 容器 gateway 不向宿主发布端口（隧道/配对/健康探针全退役，端口池废除，#747 E 节）。
  buildRunOptions(spec: ContainerSpec): Docker.ContainerCreateOptions {
    const environment = {
      ...panelEnv(),
      GATEWAY_TOKEN: spec.gatewayToken,
      // 容器内 sidecar CLI 自连 gateway 须同值 token
      OPENCLAW_GATEWAY_TOKEN: spec.gatewayToken,
      LLM_API_KEY: spec.llmApiKey,
    }
    // #590 named volume 模式（ADR 0011）：三卷 Mounts 替代 home host bind。
    const mounts: Docker.MountSettings[] | undefined = spec.volumes
      ? [
          volumeMount(spec.volumes.wiki, MOUNT_WIKI),
          volumeMount(spec.volumes.workspace, MOUNT_WORKSPACE),
          volumeMount(spec.volumes.home, HOME_BIND),
        ]
      : undefined
    return {
      Image: spec.image,
      name: containerName(spec.name),
      Env: envRecordToArray(environment),
      User: '0:0',
      Labels: {
        [LABEL_APP_KEY]: LABEL_APP_VALUE,
        [LABEL_INSTANCE_KEY]: spec.name,
      },
      HostConfig: {
        CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE'],
        ...(spec.volumes
          ? // named volume 模式：无 home bind
            { Mounts: mounts }
          : {
              // 旧 bind 模式：仅 home 目录 rw bind（openclaw.json 落其内默认路径）。
              Binds: [`${spec.homeDir}:${HOME_BIND}:rw`],
            }),
        RestartPolicy: { Name: 'unless-stopped' },
      },
    }
  }

  async run(spec: ContainerSpec): Promise<string> {
    const id = await this.create(spec)
    await this.client().getContainer(id).start()
    return id
  }

  // 只创建不启动（createComplete 先 create → seedWorkspace 灌模板卷 → start）。
  async create(spec: ContainerSpec): Promise<string> {
    await this.ensureImage(spec.image)
    const container = await this.client().createContainer(this.buildRunOptions(spec))
    return container.id
  }

  // create 前置确保镜像已就位（本地缺失则 pull；拉取失败向上抛 → createComplete 标 error 行可重试）。
  // 样板收敛（#776）：inspect-404 → pull → followProgress 逻辑与沙箱 runtime 共享（dockerImage.ts）。
  async ensureImage(image: string): Promise<void> {
    await ensureImagePulled(this.client(), image)
  }

  async listFleet(): Promise<ContainerInfo[]> {
    const cs = await this.client().listContainers({
      all: true,
      filters: { label: [`${LABEL_APP_KEY}=${LABEL_APP_VALUE}`] },
    })
    return cs.map((c) => this.toInfo(c))
  }

  async get(name: string): Promise<ContainerInfo | null> {
    try {
      const c = this.client().getContainer(containerName(name))
      const data = await c.inspect()
      return this.inspectToInfo(data)
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null
      throw e
    }
  }

  // 启动容器（删除前置修复 chown 用；已 running 幂等）。NotFound 幂等。
  async start(name: string): Promise<void> {
    try {
      await this.client().getContainer(containerName(name)).start()
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return
      throw e
    }
  }

  // 按容器 id 启动（create 返回 id → startById，消除 name 竞态）。404/304 幂等同 start。
  async startById(containerId: string): Promise<void> {
    try {
      await this.client().getContainer(containerId).start()
    } catch (e) {
      const sc = (e as { statusCode?: number }).statusCode
      if (sc === 404 || sc === 304) return
      throw e
    }
  }

  async stop(name: string): Promise<void> {
    try {
      await this.client().getContainer(containerName(name)).stop({ t: 10 })
    } catch (e) {
      const sc = (e as { statusCode?: number }).statusCode
      // 404 = 容器已消失；304 = 容器已处于 stopped（docker stop 对已停容器返 304 Not Modified）。
      // 两者均幂等成功——否则被外部 stop 的容器会让 delete worker 在此反复抛错、永远到不了 remove()，
      // 行卡 REMOVING 重试无解（Codex P2）。
      if (sc === 404 || sc === 304) return
      throw e
    }
  }

  // 删容器（v+force；NotFound 幂等）。volumes（#590 named volume 模式）提供时连带显式
  // docker volume rm 三卷（ADR 0011：remove({v:true}) 只删匿名卷，named volume 须显式删否则越攒
  // 越多）。容器 404（外部已删）也继续删卷——外部删容器不删卷，防卷泄漏；卷 404 幂等。
  async remove(name: string, volumes?: NamedVolumes): Promise<void> {
    try {
      await this.client().getContainer(containerName(name)).remove({ v: true, force: true })
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 404) throw e
      // 404（容器已不存在）：不提前返回——外部删容器不删卷，卷仍须尽力清理（防泄漏）
    }
    if (volumes) {
      for (const v of volumeOrder(volumes)) {
        try {
          await this.client().getVolume(v).remove()
        } catch (e) {
          if ((e as { statusCode?: number }).statusCode !== 404) throw e
        }
      }
    }
  }

  async execInContainer(name: string, cmd: string[]): Promise<void> {
    try {
      const c = this.client().getContainer(containerName(name))
      const exec = await c.exec({ Cmd: cmd, AttachStdout: false, AttachStderr: false })
      await exec.start({ Detach: true })
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return
      throw e
    }
  }

  // 同步等命令完成；退出码非 0 → 抛错（delete 前置 chown 修复失败须让 caller 走清理失败路径）。
  async execSync(name: string, cmd: string[]): Promise<void> {
    let c: Docker.Container
    try {
      c = this.client().getContainer(containerName(name))
      await c.inspect()
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return
      throw e
    }
    const exec = await c.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true })
    const stream = await exec.start({ Detach: false })
    const output = await this.collectOutput(stream)
    const info = await exec.inspect()
    if (info.ExitCode !== 0) {
      throw new Error(
        `exec_sync failed in ${name}: exit_code=${info.ExitCode} cmd=${JSON.stringify(cmd)} output=${JSON.stringify(output.slice(0, 500))}`,
      )
    }
  }

  private collectOutput(stream: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      stream.on('data', (d: Buffer) => chunks.push(d))
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      stream.on('error', reject)
    })
  }

  private toInfo(c: Docker.ContainerInfo): ContainerInfo {
    const labels = c.Labels ?? {}
    return {
      containerId: c.Id,
      name: (c.Names?.[0] ?? '').replace(/^\//, ''),
      running: c.State === 'running',
      status: c.State ?? '',
      image: c.Image ?? '',
      instanceName: labels[LABEL_INSTANCE_KEY] ?? null,
    }
  }

  private inspectToInfo(data: Docker.ContainerInspectInfo): ContainerInfo {
    const labels = data.Config?.Labels ?? {}
    return {
      containerId: data.Id,
      name: (data.Name ?? '').replace(/^\//, ''),
      running: data.State?.Status === 'running',
      status: data.State?.Status ?? '',
      image: data.Config?.Image ?? '',
      instanceName: labels[LABEL_INSTANCE_KEY] ?? null,
    }
  }
}
