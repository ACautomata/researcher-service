// 读写两侧共享依赖的单一装配点（平移 backend/containers/fleet/deps.py，#334）。
// 打包 runtime/config/provisioner/archive/lock/queue/crypto/dirRemover，
// 默认绑定在此一处解析；runtime 与 config 为构造必填（调用方注入），测试可单点替换任一依赖。
// T0 #801 legacy 清退：端口分配器/端口占用探测/网关健康探针随端口池与健康探针退役删除。

import { rm } from 'node:fs/promises'
import type { ContainerRuntime } from './runtime'
import type { FleetConfig } from './values'
import { HomeProvisioner } from './provisioner'
import { DockerFileArchive } from '../files/dockerArchive'
import type { FileArchive } from '../files/fsPort'
import { NameLeaseMap } from './leaseMap'
import { InlineLifecycleQueue, NameSerializer, type LifecycleQueue } from './lifecycleQueue'
import { AesGcmCrypto, type CryptoPort } from '../crypto'

// 目录删除器（默认 rm -rf 等价；可注入失败替身测清理失败 → 20045/REMOVING）
export type DirRemover = (target: string) => Promise<void>
export const defaultDirRemover: DirRemover = async (target) => {
  await rm(target, { recursive: true, force: true })
}

export interface FleetDepsOverrides {
  dirRemover?: DirRemover
  lock?: NameLeaseMap
  queue?: LifecycleQueue
  serializer?: NameSerializer
  crypto?: CryptoPort
  quotaSerializer?: NameSerializer
  // FileArchive（seedWorkspace 灌模板卷 + files 域沙箱读面共用）：测试注入内存 fake；
  // 缺省真 DockerFileArchive
  archive?: FileArchive
}

export class FleetDeps {
  readonly runtime: ContainerRuntime
  readonly config: FleetConfig
  readonly dirRemover: DirRemover
  readonly provisioner: HomeProvisioner
  // FileArchive Port（seedWorkspace 灌卷；files 域 lab 只读面共用同一 archive 装配）
  readonly archive: FileArchive
  // 进程内互斥（不依赖 Redis）：create 双创建防护 + delete/reconcile 在飞探测
  readonly lock: NameLeaseMap
  // 后台队列（生产 BullMQ；测试 inline）+ 按 name 串行器（消 delete/create 竞态）
  readonly queue: LifecycleQueue
  readonly serializer: NameSerializer
  // 凭证加密（gateway token 落盘密文；测试可注入确定性替身）
  readonly crypto: CryptoPort
  // 按 owner 串行器（配额 check+reserve 原子化，消并发不同名绕过 maxContainers——Codex C4）
  readonly quotaSerializer: NameSerializer

  constructor(runtime: ContainerRuntime, config: FleetConfig, overrides: FleetDepsOverrides = {}) {
    this.runtime = runtime
    this.config = config
    this.dirRemover = overrides.dirRemover ?? defaultDirRemover
    this.provisioner = new HomeProvisioner(config.templateDir)
    this.archive = overrides.archive ?? new DockerFileArchive()
    this.lock = overrides.lock ?? new NameLeaseMap()
    this.queue = overrides.queue ?? new InlineLifecycleQueue()
    this.serializer = overrides.serializer ?? new NameSerializer()
    this.crypto = overrides.crypto ?? new AesGcmCrypto(config.encryptionKeys)
    this.quotaSerializer = overrides.quotaSerializer ?? new NameSerializer()
  }
}
