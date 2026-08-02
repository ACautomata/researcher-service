// 容器运行时 Port（平移 backend/containers/runtime.py + integration.openclaw.ports，#334）。
// 业务层只依赖本接口（ContainerRuntime），docker 接触面在 DockerRuntime（dockerode），
// 测试注入 FakeRuntime（接缝 #5 编排器 Port）。

import { CONTAINER_PREFIX } from './constants'

// 实例名 → docker 容器名（openclaw-gw-<name>）
export function containerName(name: string): string {
  return `${CONTAINER_PREFIX}${name}`
}

// 创建一个容器所需的语义参数（orchestrator → runtime）
export interface ContainerSpec {
  readonly name: string // 实例名（不含前缀）
  readonly image: string
  readonly hostPort: number // 宿主映射端口（端口池分配）
  readonly gatewayToken: string // GATEWAY_TOKEN env 值（敏感：仅 env 注入，不落盘）
  readonly homeDir: string // 宿主 bind-mount home（instances/<name>/home）
  readonly configPath: string // 宿主 openclaw.json（instances/<name>/openclaw.json）
  readonly llmApiKey: string // 全面板共享 LLM_API_KEY
}

// 一个容器的运行时状态快照（runtime → orchestrator）
export interface ContainerInfo {
  readonly containerId: string
  readonly name: string
  readonly running: boolean
  readonly status: string // docker status 原值：running/exited/...
  readonly image: string
  // 宿主映射端口（来自 openclaw.port label），供端口分配对账；未跟踪/无 label 时为 null
  readonly port: number | null
  // 实例名（来自 openclaw.instance label）——reconcile/delete 用它校验容器所有权；无 label 时为 null
  readonly instanceName: string | null
}

// 容器运行时接触面（docker daemon 原语）。DockerRuntime 与 FakeRuntime 结构满足本接口。
export interface ContainerRuntime {
  // 创建并启动一个容器，返回 docker container id
  run(spec: ContainerSpec): Promise<string>
  // 列出本面板（label app=openclaw-fleet）全部容器
  listFleet(): Promise<ContainerInfo[]>
  // 枚举宿主上与发布地址冲突的活动容器宿主端口（含未跟踪容器；daemon 不可达 → 空集）
  hostPublishedPorts(): Promise<Set<number>>
  // 取单个容器；不存在 → null
  get(name: string): Promise<ContainerInfo | null>
  // 启动容器（删除前置修复 chown 用——容器被外部停止后 docker 无法在 stopped 容器内 exec，须先 start）
  start(name: string): Promise<void>
  // 停容器（NotFound 幂等）
  stop(name: string): Promise<void>
  // 删容器（v+force；NotFound 幂等）
  remove(name: string): Promise<void>
  // fire-and-forget 容器内执行（如 wiki compile）；NotFound 幂等
  execInContainer(name: string, cmd: string[]): Promise<void>
  // 同步等命令完成；退出码非 0 → 抛错（如 approve CLI）；NotFound 幂等
  execSync(name: string, cmd: string[]): Promise<void>
}
