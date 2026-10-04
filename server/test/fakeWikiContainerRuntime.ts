// 假 wiki 容器 runtime（#784 · S2 接缝：注入 WikiContainerLifecycle 测生命周期闭环，不需真
// daemon）。全内存模拟 WikiContainerRuntime：create/start/remove/list/export/import 各原语
// 记录调用序列，可注入故障。刻意镜像真 daemon 的标签过滤语义：listWikis 只返回带 kind=wiki
// 标签的容器（fakeSandboxRuntime 同款判定源共享）。

import type { WikiContainerInfo, WikiContainerRuntime, WikiContainerSpec } from '../src/wikiContainers/runtime'

export interface FakeWikiContainerRecord {
  info: WikiContainerInfo
  spec: WikiContainerSpec
  removed: boolean
}

export class FakeWikiContainerRuntime implements WikiContainerRuntime {
  readonly containers = new Map<string, FakeWikiContainerRecord>()
  private idSeq = 0
  // 调用序列（断言 create→start 时序、restore 的 import→remove→create→start 编排）
  readonly calls: { kind: string; ownerId?: string; image?: string }[] = []
  // 故障注入：对指定 ownerId 的 createWiki 抛错
  failCreateFor = new Set<string>()

  async createWiki(spec: WikiContainerSpec): Promise<string> {
    this.calls.push({ kind: 'createWiki', ownerId: spec.ownerId, image: spec.image })
    if (this.failCreateFor.has(spec.ownerId)) throw new Error(`simulated wiki create failure: ${spec.ownerId}`)
    const id = `fake-wiki-${spec.ownerId}-${this.idSeq++}`
    this.containers.set(spec.ownerId, {
      info: {
        containerId: id,
        ownerId: spec.ownerId,
        running: false,
        status: 'created',
        image: spec.image,
      },
      spec,
      removed: false,
    })
    return id
  }

  async getWiki(ownerId: string): Promise<WikiContainerInfo | null> {
    return this.containers.get(ownerId)?.info ?? null
  }

  async startWiki(ownerId: string): Promise<void> {
    this.calls.push({ kind: 'startWiki', ownerId })
    const rec = this.containers.get(ownerId)
    if (!rec) return
    rec.info = { ...rec.info, running: true, status: 'running' }
  }

  async removeWiki(ownerId: string): Promise<void> {
    this.calls.push({ kind: 'removeWiki', ownerId })
    this.containers.delete(ownerId)
  }

  // export 记录被导出的 ownerId（tar 内容 = 注册时塞入的 bytes，缺省空）
  readonly exports: string[] = []
  readonly exportBytes = new Map<string, Buffer>()

  async exportWiki(ownerId: string): Promise<Buffer> {
    this.calls.push({ kind: 'exportWiki', ownerId })
    this.exports.push(ownerId)
    return this.exportBytes.get(ownerId) ?? Buffer.alloc(0)
  }

  // import 记录 (ownerId, tar) 并返回还原镜像引用（真实形状：repo:ownerId）
  readonly imports: { ownerId: string; tar: Buffer }[] = []

  async importWiki(ownerId: string, tar: Buffer): Promise<string> {
    this.calls.push({ kind: 'importWiki', ownerId })
    this.imports.push({ ownerId, tar })
    return `researcher-wiki-restore:${ownerId}`
  }
}
