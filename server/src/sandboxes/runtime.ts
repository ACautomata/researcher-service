// 沙箱运行时 Port（#776 · S2「编排器 Port 延伸」真身）。
// 业务层（lifecycle.ts）只依赖本接口（SandboxRuntime），docker 接触面在 DockerSandboxRuntime
// （dockerode），测试注入 FakeSandboxRuntime（wiki 容器 WikiContainerRuntime 同构先例）。
//
// 与 #859 已退役的 fleet ContainerRuntime 的分野（历史注记）：沙箱无 DB 行、无宿主端口、
// 无 token/config 渲染、无 5 态机
//（「对容器列表隐身 = 纯 session 实现细节」，生命周期归 runner/BullMQ 侧调用方）；键一律是 sessionId，
// docker 名/网络名由本模块单一来源函数派生，调用方不手拼。

import type { SandboxLimits } from './values'
import { SANDBOX_CONTAINER_PREFIX, SANDBOX_NETWORK_PREFIX } from './values'

// sessionId → 沙箱 docker 容器名（researcher-sandbox-<sessionId>；前缀单一来源 values.ts）
export function sandboxContainerName(sessionId: string): string {
  return `${SANDBOX_CONTAINER_PREFIX}${sessionId}`
}

// sessionId → 沙箱独立 bridge 网络名（researcher-sandbox-net-<sessionId>；前缀单一来源 values.ts）
export function sandboxNetworkName(sessionId: string): string {
  return `${SANDBOX_NETWORK_PREFIX}${sessionId}`
}

// sessionId → fork 导入镜像名（<沙箱前缀>fs-<sessionId>；#781 字面复制的 FS 快照，
// 随容器 remove 顺手 rmi——前缀单一来源 values.ts，防漂移）
export function sandboxFsImageName(sessionId: string): string {
  return `${SANDBOX_CONTAINER_PREFIX}fs-${sessionId}`
}

// 创建一个沙箱所需的语义参数（lifecycle → runtime）
export interface SandboxSpec {
  readonly sessionId: string
  readonly image: string
  readonly limits: SandboxLimits
}

// fork 字面复制参数（#781 · #768 D7）：目标沙箱语义参数 + 源沙箱 session。刻意不带 image——
// 目标容器镜像恒由实现侧派生（fsImage = 源容器 export→import 的专属镜像），接口上不留给
// 调用方「指定 image」的误导面。
export interface SandboxForkSpec extends Omit<SandboxSpec, 'image'> {
  readonly sourceSessionId: string
}

// 一个沙箱的运行时状态快照（runtime → lifecycle）；health = docker inspect Running
//（#747 E 节：无 /health 探针、无宿主端口，活性即 inspect）。
export interface SandboxInfo {
  readonly containerId: string
  readonly sessionId: string
  readonly running: boolean
  readonly status: string // docker status 原值：running/exited/created/...
  readonly image: string
}

// 沙箱运行时接触面（docker daemon 原语）。DockerSandboxRuntime 与 FakeSandboxRuntime 满足本接口。
export interface SandboxRuntime {
  // 确保沙箱网络存在（已存在 → 幂等成功）；容器建在其上（每沙箱独立 bridge，容器间零互通）
  createNetwork(sessionId: string): Promise<void>
  // 删沙箱网络（不存在 → 幂等成功）
  removeNetwork(sessionId: string): Promise<void>
  // 创建沙箱容器（不启动）：资源 limit/安全 profile/标签 + /lab 属主预置（putArchive uid 1000）。
  // 返回 docker container id。
  createSandbox(spec: SandboxSpec): Promise<string>
  // fork 字面复制（#781 · #768 D7「整容器字面文件系统复制，含墓碑目录」）：docker export 源
  // 容器流式导出 → import 为目标专属镜像 → 以常规沙箱参数建目标容器（Image = 导入镜像）。
  // 源容器不存在 → 'source-missing'（不建目标容器，调用方空起步）；网络创建归 lifecycle。
  createSandboxFromSource(spec: SandboxForkSpec): Promise<'copied' | 'source-missing'>
  // 按 sessionId 取沙箱；不存在 → null
  getSandbox(sessionId: string): Promise<SandboxInfo | null>
  // 启动沙箱（已 running → 幂等成功；不存在 → 幂等成功，后续调用再暴露）
  startSandbox(sessionId: string): Promise<void>
  // 停沙箱（文件保留：可写层不动；NotFound/已停幂等）——闲置回收与 OOM 后容器存活语义的落点
  stopSandbox(sessionId: string): Promise<void>
  // 删沙箱容器（force；可写层随之销毁，/lab 文件与容器同生共死）；NotFound 幂等
  removeSandbox(sessionId: string): Promise<void>
  // 列出全部沙箱（label researcher.kind=sandbox，含 running/exited）
  listSandboxes(): Promise<SandboxInfo[]>
}
