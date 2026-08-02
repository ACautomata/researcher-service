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
  containerName,
} from './ports'

// 容器运行时 Port（可注入替身）：编排层只依赖这些语义方法，dockerode 实现在此封装。
// 测试注入假 runtime（内存容器表）→ 接缝 5 无需真 docker daemon。

export interface ContainerSpec {
  name: string // 实例名（不含前缀）
  image: string
  hostPort: number // 宿主映射端口（端口池分配）
  gatewayToken: string // GATEWAY_TOKEN env 值（仅 env 注入，不落盘）
  homeDir: string // 宿主 bind-mount home（instances/<name>/home）
  configPath: string // 宿主 openclaw.json（instances/<name>/openclaw.json）
  llmApiKey: string // 全面板共享 LLM_API_KEY
}

export interface ContainerInfo {
  containerId: string
  name: string // docker 容器名（openclaw-gw-<name>）
  running: boolean
  status: string // docker status 原值：running/exited/...
  image: string
  port: number | null // 宿主映射端口（来自 openclaw.port label）
  instanceName: string | null // 实例名（来自 openclaw.instance label）
}

export interface ContainerRuntime {
  run(spec: ContainerSpec): Promise<string>
  get(name: string): Promise<ContainerInfo | null>
  stop(name: string): Promise<void>
  remove(name: string): Promise<void>
  listFleet(): Promise<ContainerInfo[]>
  hostPublishedPorts(): Promise<Set<number>>
  execSync(name: string, cmd: string[]): Promise<void>
}

// dockerode 适配层（spec §5.4）。构造不连 daemon（lazy client）；生产由 server.ts 装配。
export class DockerRuntime implements ContainerRuntime {
  private docker: Docker | null = null

  constructor(
    private readonly publishHost = '127.0.0.1',
    private readonly dockerFactory: () => Docker = () => new Docker(),
  ) {}

  private client(): Docker {
    if (!this.docker) this.docker = this.dockerFactory()
    return this.docker
  }

  async run(spec: ContainerSpec): Promise<string> {
    const container = await this.client().createContainer({
      Image: spec.image,
      name: containerName(spec.name),
      User: '0:0',
      Env: [
        `GATEWAY_TOKEN=${spec.gatewayToken}`,
        `OPENCLAW_GATEWAY_TOKEN=${spec.gatewayToken}`,
        `LLM_API_KEY=${spec.llmApiKey}`,
        `OPENCLAW_GATEWAY_PORT=${GATEWAY_INTERNAL_PORT}`,
        `OPENCLAW_GATEWAY_BIND=${GATEWAY_BIND}`,
        'OPENCLAW_GATEWAY_MODE=local',
        'OPENCLAW_WORKSPACE_ROOT=/home/node/.openclaw',
        'TZ=Asia/Shanghai',
        'HOME=/home/node',
        'TERM=xterm-256color',
        'NODE_ENV=production',
      ],
      HostConfig: {
        Binds: [
          `${spec.homeDir}:${HOME_BIND}`,
          `${spec.configPath}:${CONFIG_BIND}:ro`, // ro 防容器内篡改配置
        ],
        PortBindings: {
          [`${GATEWAY_INTERNAL_PORT}/tcp`]: [
            { HostIp: this.publishHost, HostPort: String(spec.hostPort) },
          ],
        },
        RestartPolicy: { Name: 'unless-stopped' },
        CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE'],
      },
      Labels: {
        [LABEL_APP_KEY]: LABEL_APP_VALUE,
        [LABEL_INSTANCE_KEY]: spec.name,
        [LABEL_PORT_KEY]: String(spec.hostPort),
      },
    })
    await container.start()
    return container.id
  }

  async get(name: string): Promise<ContainerInfo | null> {
    try {
      const c = await this.client().getContainer(containerName(name)).inspect()
      return this.toInfo(c)
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null
      throw e
    }
  }

  async stop(name: string): Promise<void> {
    try {
      const c = await this.client().getContainer(containerName(name))
      await c.stop({ t: 10 })
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return
      throw e
    }
  }

  async remove(name: string): Promise<void> {
    try {
      const c = await this.client().getContainer(containerName(name))
      await c.remove({ force: true, v: true })
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return
      throw e
    }
  }

  async listFleet(): Promise<ContainerInfo[]> {
    const list = await this.client().listContainers({
      all: true,
      filters: { label: [`${LABEL_APP_KEY}=${LABEL_APP_VALUE}`] },
    })
    const infos: ContainerInfo[] = []
    for (const item of list) {
      const port = item.Labels?.[LABEL_PORT_KEY]
      infos.push({
        containerId: item.Id,
        name: item.Names?.[0] ?? '',
        running: item.State === 'running',
        status: item.State ?? '',
        image: item.Image ?? '',
        port: port ? Number(port) : null,
        instanceName: item.Labels?.[LABEL_INSTANCE_KEY] ?? null,
      })
    }
    return infos
  }

  async hostPublishedPorts(): Promise<Set<number>> {
    const published = new Set<number>()
    try {
      const list = await this.client().listContainers({ all: true })
      for (const item of list) {
        if (item.State === 'exited' || item.State === 'created' || item.State === 'dead') continue
        const bindings = (item.Ports ?? []).filter((p) => p.PublicPort != null)
        for (const p of bindings) published.add(p.PublicPort!)
      }
    } catch {
      // daemon 不可达 → 空集（不误报占用）
    }
    return published
  }

  async execSync(name: string, cmd: string[]): Promise<void> {
    try {
      const c = await this.client().getContainer(containerName(name))
      const result = await c.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true })
      const stream = await result.start({ Detach: false })
      await new Promise<void>((resolve, reject) => {
        let code: number | null = null
        stream.on('end', () => (code === 0 ? resolve() : reject(new Error(`exec failed code=${code}`))))
        stream.on('error', reject)
      })
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return
      throw e
    }
  }

  private toInfo(c: Docker.ContainerInspectInfo): ContainerInfo {
    const labels = c.Config?.Labels ?? {}
    const rawPort = labels[LABEL_PORT_KEY]
    return {
      containerId: c.Id ?? '',
      name: c.Name ?? '',
      running: c.State?.Running ?? false,
      status: c.State?.Status ?? '',
      image: c.Config?.Image ?? '',
      port: rawPort ? Number(rawPort) : null,
      instanceName: labels[LABEL_INSTANCE_KEY] ?? null,
    }
  }
}
