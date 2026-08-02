// DockerRuntime —— dockerode 适配层（平移 backend/containers/docker_runtime.py，#334）。
// buildRunOptions 是纯逻辑 seam（不调 daemon），run/listFleet/get/stop/remove 经 docker client 操作 daemon。
// client 延迟注入（默认 new Docker() 挂 /var/run/docker.sock）——构造时不连 daemon，仅实际调用时才连。

import Docker from 'dockerode'
import {
  CONFIG_BIND,
  GATEWAY_BIND,
  GATEWAY_INTERNAL_PORT,
  HOME_BIND,
  LABEL_APP_KEY,
  LABEL_APP_VALUE,
  LABEL_INSTANCE_KEY,
  LABEL_PORT_KEY,
} from './constants'
import { containerName, type ContainerInfo, type ContainerRuntime, type ContainerSpec } from './runtime'

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
  OPENCLAW_WORKSPACE_ROOT: HOME_BIND,
  DM_POLICY: 'disabled',
  GROUP_POLICY: 'disabled',
  ALLOW_FROM: '',
  OPENCLAW_PLUGINS_ENABLED: 'true',
}

function envRecordToArray(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`)
}

export class DockerRuntime implements ContainerRuntime {
  private cached: Docker | null = null

  // publishHost 默认 127.0.0.1（loopback 收敛暴露面）；生产后端容器化后 0.0.0.0。
  constructor(
    private readonly clientFactory: () => Docker = () => new Docker(),
    private readonly publishHost: string = '127.0.0.1',
  ) {}

  private client(): Docker {
    if (this.cached === null) this.cached = this.clientFactory()
    return this.cached
  }

  // 构造 docker create 参数（纯逻辑，可单测）。
  buildRunOptions(spec: ContainerSpec): Docker.ContainerCreateOptions {
    const environment = {
      ...BASE_ENV,
      ...SYNC_FLAGS_OFF,
      GATEWAY_TOKEN: spec.gatewayToken,
      // 容器内 sidecar CLI（approve/exec 审批注册）自连 gateway 须同值 token
      OPENCLAW_GATEWAY_TOKEN: spec.gatewayToken,
      LLM_API_KEY: spec.llmApiKey,
    }
    return {
      Image: spec.image,
      name: containerName(spec.name),
      Env: envRecordToArray(environment),
      User: '0:0',
      Labels: {
        [LABEL_APP_KEY]: LABEL_APP_VALUE,
        [LABEL_INSTANCE_KEY]: spec.name,
        [LABEL_PORT_KEY]: String(spec.hostPort),
      },
      HostConfig: {
        CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE'],
        Binds: [
          `${spec.homeDir}:${HOME_BIND}:rw`,
          // openclaw.json 挂 ro（防容器内篡改配置；host 侧写透经 bind 传播不受 ro 影响）
          `${spec.configPath}:${CONFIG_BIND}:ro`,
        ],
        PortBindings: {
          [`${GATEWAY_INTERNAL_PORT}/tcp`]: [{ HostIp: this.publishHost, HostPort: String(spec.hostPort) }],
        },
        RestartPolicy: { Name: 'unless-stopped' },
      },
    }
  }

  async run(spec: ContainerSpec): Promise<string> {
    await this.ensureImage(spec.image)
    const container = await this.client().createContainer(this.buildRunOptions(spec))
    await container.start()
    return container.id
  }

  // create 前确保镜像已就位（Codex 第四轮③[P1]）：Engine createContainer 对本地缺失的镜像返回
  // image-not-found——干净 host / OPENCLAW_IMAGE 换成未缓存 tag 时 create 必 error。CI 此前靠手动
  // docker pull 掩盖。这里仅本地缺失时拉取（getImage().inspect() 404 → 拉；已缓存 → 跳过，避免
  // 每次 create 都重复 pull）。pull 经 modem.followProgress 消费进度流（不消费则流不 flowing、
  // pull 永不完成）。拉取失败向上抛 → createComplete 标 error 行（可重试）。
  private async ensureImage(image: string): Promise<void> {
    try {
      await this.client().getImage(image).inspect()
      return
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 404) throw e // daemon 故障等真错不吞
    }
    const stream = await this.client().pull(image)
    await new Promise<void>((resolve, reject) => {
      const modem = (
        this.client() as Docker & { modem: { followProgress(s: NodeJS.ReadableStream, f: (err: Error | null) => void): void } }
      ).modem
      modem.followProgress(stream, (err) => (err ? reject(err) : resolve()))
    })
  }

  async listFleet(): Promise<ContainerInfo[]> {
    const cs = await this.client().listContainers({
      all: true,
      filters: { label: [`${LABEL_APP_KEY}=${LABEL_APP_VALUE}`] },
    })
    return cs.map((c) => this.toInfo(c))
  }

  // 枚举宿主上与发布地址冲突的活动容器宿主端口（含未跟踪容器；daemon 不可达 → 空集）。
  async hostPublishedPorts(): Promise<Set<number>> {
    const published = new Set<number>()
    let cs: Docker.ContainerInfo[]
    try {
      cs = await this.client().listContainers({ all: true })
    } catch {
      return published
    }
    for (const c of cs) {
      // exited/created/dead 容器保留 PortBindings 但 daemon 已收回端口（无活跃 docker-proxy）→ 跳过
      if (c.State === 'exited' || c.State === 'created' || c.State === 'dead') continue
      for (const p of c.Ports ?? []) {
        if (p.PublicPort === undefined) continue
        const hostIp = p.IP ?? '0.0.0.0'
        // 通配绑定（空/0.0.0.0）与任意发布地址冲突；具体地址仅在同 publishHost 时冲突。
        if (this.publishHost !== '0.0.0.0' && hostIp !== '0.0.0.0' && hostIp !== this.publishHost) continue
        published.add(p.PublicPort)
      }
    }
    return published
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

  async remove(name: string): Promise<void> {
    try {
      await this.client().getContainer(containerName(name)).remove({ v: true, force: true })
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return
      throw e
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

  // 同步等命令完成；退出码非 0 → 抛错（approve CLI 失败须让 caller 走 STATUS_ERROR 路径）。
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
    const rawPort = labels[LABEL_PORT_KEY]
    const port = rawPort !== undefined ? Number.parseInt(rawPort, 10) : null
    return {
      containerId: c.Id,
      name: (c.Names?.[0] ?? '').replace(/^\//, ''),
      running: c.State === 'running',
      status: c.State ?? '',
      image: c.Image ?? '',
      port: Number.isNaN(port) ? null : port,
      instanceName: labels[LABEL_INSTANCE_KEY] ?? null,
    }
  }

  private inspectToInfo(data: Docker.ContainerInspectInfo): ContainerInfo {
    const labels = data.Config?.Labels ?? {}
    const rawPort = labels[LABEL_PORT_KEY]
    const port = rawPort !== undefined ? Number.parseInt(rawPort, 10) : null
    return {
      containerId: data.Id,
      name: (data.Name ?? '').replace(/^\//, ''),
      running: data.State?.Status === 'running',
      status: data.State?.Status ?? '',
      image: data.Config?.Image ?? '',
      port: Number.isNaN(port) ? null : port,
      instanceName: labels[LABEL_INSTANCE_KEY] ?? null,
    }
  }
}
