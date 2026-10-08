// wiki 容器运行时 Port（#784 · S2「编排器 Port 延伸」真身，沙箱 Port 同构）。
// 业务层（lifecycle.ts）只依赖本接口（WikiContainerRuntime），docker 接触面在
// DockerWikiContainerRuntime（dockerode），测试注入 FakeWikiContainerRuntime
//（先例：sandboxes/runtime.ts 的 SandboxRuntime）。
//
// 与 #859 已退役的 fleet ContainerRuntime 的分野（沙箱同款，历史注记）：无 DB 行、无宿主端口、
// 无 token/config 渲染、无 5 态机；键一律是 userId，docker 名由本模块单一来源函数派生，调用方不手拼。
// 与沙箱 Port 的刻意分野：无网络原语（NetworkMode none 零出网，无网络对象可建可删）；
// 增备份/还原双原语（docker export 全树 tar ⇄ docker import 成镜像，E 节「无具名卷（备份 =
// docker export 全树 tar）」的唯一持久性出口）。

import type { WikiLimits } from './values'
import { WIKI_CONTAINER_PREFIX } from './values'

// userId → wiki 容器 docker 名（researcher-wiki-<userId>；前缀单一来源 values.ts）
export function wikiContainerName(ownerId: string): string {
  return `${WIKI_CONTAINER_PREFIX}${ownerId}`
}

// 还原镜像的 repo/tag（docker import 产物；tag = ownerId——cuid 全小写字母数字，合法 tag）。
// 固定 repo 复用同名 tag：重复还原覆盖旧镜像，不越攒。
export const WIKI_RESTORE_REPO = 'researcher-wiki-restore'

// 还原镜像引用（runtime.importWiki 返回值与 lifecycle.restore 的 create 镜像同源）。
export function wikiRestoreImageRef(ownerId: string): string {
  return `${WIKI_RESTORE_REPO}:${ownerId}`
}

// 创建一个 wiki 容器所需的语义参数（lifecycle → runtime）
export interface WikiContainerSpec {
  readonly ownerId: string
  readonly image: string
  readonly limits: WikiLimits
}

// 一个 wiki 容器的运行时状态快照（runtime → lifecycle）；health = docker inspect Running
//（#747 E 节：无 /health 探针、无宿主端口，活性即 inspect）。
export interface WikiContainerInfo {
  readonly containerId: string
  readonly ownerId: string
  readonly running: boolean
  readonly status: string // docker status 原值：running/exited/created/...
  readonly image: string
}

// wiki 容器运行时接触面（docker daemon 原语）。DockerWikiContainerRuntime 与
// FakeWikiContainerRuntime 满足本接口。与沙箱 Port 的差异：无 list 原语（wiki 容器无闲置
// 回收面，消费方按 ownerId 寻址——list 随首个真实消费方再加，YAGNI）。
export interface WikiContainerRuntime {
  // 创建 wiki 容器（不启动）：资源 limit/安全 profile/标签 + /wiki 属主预置（putArchive
  // uid 1000，零初始化——无骨架）。返回 docker container id。
  createWiki(spec: WikiContainerSpec): Promise<string>
  // 按 ownerId 取 wiki 容器；不存在 → null。防御性识别：派生名上的容器 kind 标签 ≠ wiki
  //（外来同名容器）视为不存在——ensure 不在其上读写、remove 不误删（沙箱 toInfoCommon 同构）。
  getWiki(ownerId: string): Promise<WikiContainerInfo | null>
  // 启动 wiki 容器（已 running → 幂等成功；不存在 → 幂等成功，后续调用再暴露）
  startWiki(ownerId: string): Promise<void>
  // 删 wiki 容器（force；可写层随之销毁——/wiki 文件与容器同生共死，持久性唯一出口 =
  // backup/exportWiki 全树 tar）；NotFound 幂等
  removeWiki(ownerId: string): Promise<void>
  // docker export 全树 tar（含可写层 /wiki 数据；uid/gid 原样保留）——备份唯一出口
  exportWiki(ownerId: string): Promise<Buffer>
  // docker import 全树 tar → 还原镜像（researcher-wiki-restore:<ownerId>）；返回镜像引用。
  // 只建镜像不动容器——容器重建（createWiki 以该镜像）归 lifecycle.restore 编排。
  importWiki(ownerId: string, tar: Buffer): Promise<string>
}
