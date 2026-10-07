// 容器运行时 Port（平移 backend/containers/runtime.py，#334）。
// 业务层只依赖本接口（ContainerRuntime），docker 接触面在 DockerRuntime（dockerode），
// 测试注入 FakeRuntime（接缝 #5 编排器 Port）。
// T0 #801 legacy 清退：宿主端口发布/端口对账/oneshot 升级编排全组退役（无消费者——浏览器经
// REST+SSE 直连控制面，容器 gateway 不再有外部连接方）。

import { CONTAINER_PREFIX, VOLUME_HOME_PREFIX, VOLUME_WIKI_PREFIX, VOLUME_WORKSPACE_PREFIX } from './constants'

// 实例名 → docker 容器名（openclaw-gw-<name>）
export function containerName(name: string): string {
  return `${CONTAINER_PREFIX}${name}`
}

// #590 named volume 拓扑（ADR 0011）：每容器三卷。wiki/workspace 卷在子路径遮蔽 home 卷，
// 属正常叠加；空卷首挂由镜像内 ~/.openclaw 骨架自动初始化（#588 派生镜像）。
export interface NamedVolumes {
  readonly wiki: string
  readonly workspace: string
  readonly home: string
}

// 按代系 id（#360）派生三卷名（openclaw-<kind>-<id>）——每代唯一，删容器连卷删、同名 recreate
// 用新卷组，防在飞 wiki/长扫描期间容器被删+同名重建给他人时读写新 owner 数据。
export function namedVolumesFor(instanceId: string): NamedVolumes {
  return {
    wiki: `${VOLUME_WIKI_PREFIX}${instanceId}`,
    workspace: `${VOLUME_WORKSPACE_PREFIX}${instanceId}`,
    home: `${VOLUME_HOME_PREFIX}${instanceId}`,
  }
}

// 三卷删除顺序单一来源（docker volume rm 顺序：wiki → workspace → home；FakeRuntime 记录与
// 测试断言同源，防四处手写顺序漂移）
export function volumeOrder(v: NamedVolumes): [string, string, string] {
  return [v.wiki, v.workspace, v.home]
}

// 创建一个容器所需的语义参数（orchestrator → runtime）
export interface ContainerSpec {
  readonly name: string // 实例名（不含前缀）
  readonly image: string
  readonly gatewayToken: string // GATEWAY_TOKEN env 值（敏感：仅 env 注入，不落盘）
  readonly homeDir: string // 宿主 bind-mount home（instances/<id>/home，代系绑定 #360；
  // rw bind 承载 workspace/wiki/state/logs；OPENCLAW_NAMED_VOLUMES 开启时不用）
  // #590 named volume 拓扑（ADR 0011）：提供时 buildRunOptions 生成三卷 Mounts 替代 home bind
  // （挂载点 ~/.openclaw/wiki/main + ~/.openclaw/workspace + ~/.openclaw）；缺省 undefined =
  // 旧 bind 模式（homeDir 生效）。
  readonly volumes?: NamedVolumes
  readonly llmApiKey: string // 全面板共享 LLM_API_KEY
}

// 一个容器的运行时状态快照（runtime → orchestrator）
export interface ContainerInfo {
  readonly containerId: string
  readonly name: string
  readonly running: boolean
  readonly status: string // docker status 原值：running/exited/...
  readonly image: string
  // 实例名（来自 openclaw.instance label）——reconcile/delete 用它校验容器所有权；无 label 时为 null
  readonly instanceName: string | null
}

// 容器运行时接触面（docker daemon 原语）。DockerRuntime 与 FakeRuntime 结构满足本接口。
export interface ContainerRuntime {
  // 确保镜像已本地就位（缺失则 pull）
  ensureImage(image: string): Promise<void>
  // 创建并启动一个容器，返回 docker container id
  run(spec: ContainerSpec): Promise<string>
  // 只创建容器（不启动），返回 docker container id（createComplete create → seedWorkspace →
  // start，首启 gateway 即读镜像内默认配置）
  create(spec: ContainerSpec): Promise<string>
  // 列出本面板（label app=openclaw-fleet）全部容器
  listFleet(): Promise<ContainerInfo[]>
  // 取单个容器；不存在 → null
  get(name: string): Promise<ContainerInfo | null>
  // 启动容器（删除前置修复 chown 用——容器被外部停止后 docker 无法在 stopped 容器内 exec，须先 start）
  start(name: string): Promise<void>
  // 按容器 id 启动（createComplete 的 create 返回 id → startById，消除 name 竞态；NotFound 幂等）
  startById(containerId: string): Promise<void>
  // 停容器（NotFound/304 幂等）
  stop(name: string): Promise<void>
  // 删容器（v+force；NotFound 幂等）。volumes（#590 named volume 模式）提供时连带显式
  // docker volume rm 三卷（ADR 0011：remove({v:true}) 只删匿名卷，named volume 须显式删；
  // 容器 404 也尽力删卷——外部删容器不删卷，防卷越攒越多；卷 404 幂等）
  remove(name: string, volumes?: NamedVolumes): Promise<void>
  // fire-and-forget 容器内执行；NotFound 幂等
  execInContainer(name: string, cmd: string[]): Promise<void>
  // 同步等命令完成；退出码非 0 → 抛错（delete 前置 chown 修复用）
  execSync(name: string, cmd: string[]): Promise<void>
}
