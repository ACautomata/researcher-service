// wiki 容器生命周期编排（#784 · S2「编排器 Port 延伸」业务层，沙箱 lifecycle 同构）。
// kind=wiki 支路（标签识别准据 containers/kind.ts containerKind；#858 起分派表随 fleet 退役）：
//   - ensure：create（不存在）/ start（stopped）/ 原样（running）+ liveness 快照——wiki 域 REST
//     与 runner run 前的 create/health 合一入口（「活性 = docker inspect Running」，无探针无端口）；
//   - remove：删容器（可写层 /wiki 随之销毁）。**永久容器**：随用户生命周期（orchestrator 管理，
//     删除带确认门）——消费点 = 用户级联删（用户删除面尚未落地）与 T0 清理，无闲置回收面
//    （沙箱有 sweeper、wiki 刻意没有）；
//   - backup/restore：docker export 全树 tar ⇄ docker import 成镜像后重建容器（E 节「无具名卷
//     （备份 = docker export 全树 tar）」的唯一持久性出口）。
//
// 串行模型：per-owner NameSerializer（沙箱/fleet 同 name 串行先例）——并发 ensure 只落一次
// create；ensure 与 remove/restore 同 owner 排队，消「create 半途被删/还原」竞态。
//
// 无时钟、无活动 map：永久容器无闲置判定（沙箱 sweepIdle 的刻意缺席面）。

import { NameSerializer } from '../containers/lifecycleQueue'
import type { WikiContainerInfo, WikiContainerRuntime } from './runtime'
import { WIKI_LIMITS, type WikiLimits } from './values'

export interface WikiContainerLifecycleOptions {
  /** wiki 容器镜像（config.wikiContainers.image） */
  readonly image: string
  /** 资源 limit 覆盖（缺省 WIKI_LIMITS 规格初值；smoke 用小值） */
  readonly limits?: WikiLimits
}

export type WikiRemoveOutcome = 'removed' | 'not-found'

export class WikiContainerLifecycle {
  private readonly serializer = new NameSerializer()

  constructor(
    private readonly runtime: WikiContainerRuntime,
    private readonly opts: WikiContainerLifecycleOptions,
  ) {}

  // 惰性创建 + 确保运行（幂等）：running → 原样返回；stopped → start（可写层跨 stop/start
  // 存续）；不存在 → create（零初始化）→ start。返回值恒为 runtime 实况快照（stopped 复启
  // 分支 start 后重查——返回陈旧 running:false 会误导消费方）。
  ensure(ownerId: string): Promise<WikiContainerInfo> {
    return this.serializer.enqueue(ownerId, async () => {
      const existing = await this.runtime.getWiki(ownerId)
      if (existing !== null) {
        if (!existing.running) {
          await this.runtime.startWiki(ownerId)
          const fresh = await this.runtime.getWiki(ownerId)
          return fresh ?? { ...existing, running: true, status: 'running' }
        }
        return existing
      }
      const id = await this.runtime.createWiki({
        ownerId,
        image: this.opts.image,
        limits: this.opts.limits ?? WIKI_LIMITS,
      })
      await this.runtime.startWiki(ownerId)
      return createdInfo(ownerId, id, this.opts.image)
    })
  }

  // 删 wiki 容器（用户级联删 / T0 清理面）：可写层随之销毁。不存在 → 'not-found'
  // （幂等，级联链安全重试）。无网络清理面（NetworkMode none，无网络对象）。
  remove(ownerId: string): Promise<WikiRemoveOutcome> {
    return this.serializer.enqueue(ownerId, async () => {
      const existing = await this.runtime.getWiki(ownerId)
      if (existing === null) return 'not-found'
      await this.runtime.removeWiki(ownerId)
      return 'removed'
    })
  }

  // 备份：docker export 全树 tar（含 /wiki 数据与属主）。stopped 容器同样可备份
  //（daemon 原语无进程依赖）——不 ensure，备份不改变容器状态。
  backup(ownerId: string): Promise<Buffer> {
    return this.serializer.enqueue(ownerId, () => this.runtime.exportWiki(ownerId))
  }

  // 还原：import 全树 tar 成镜像 → 删现有容器（如有）→ 以还原镜像重建容器 → 启动。
  // 还原镜像的 /wiki 属主为导出时原值（uid 1000）；createWiki 的属主预置对既有 /wiki 目录
  // 条目幂等（重写同值 uid/gid/mode，不动内容）。
  restore(ownerId: string, tar: Buffer): Promise<WikiContainerInfo> {
    return this.serializer.enqueue(ownerId, async () => {
      const imageRef = await this.runtime.importWiki(ownerId, tar)
      await this.runtime.removeWiki(ownerId)
      const id = await this.runtime.createWiki({
        ownerId,
        image: imageRef,
        limits: this.opts.limits ?? WIKI_LIMITS,
      })
      await this.runtime.startWiki(ownerId)
      return createdInfo(ownerId, id, imageRef)
    })
  }
}

// create/restore 成功路径的 running 快照（单点构造，防两处字面量漂移）
function createdInfo(ownerId: string, containerId: string, image: string): WikiContainerInfo {
  return { containerId, ownerId, running: true, status: 'running', image }
}
