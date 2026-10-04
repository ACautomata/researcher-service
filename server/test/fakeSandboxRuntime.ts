// 假沙箱 runtime（#776 · S2 接缝：注入 SandboxLifecycle 测生命周期闭环，不需真 daemon）。
// 全内存模拟 SandboxRuntime：create/start/stop/remove/list 各原语记录调用序列，可注入故障。
// 刻意镜像真 daemon 的标签过滤语义：listSandboxes 只返回带 kind=sandbox 标签的容器——供
// 「沙箱对容器列表隐身」类断言共享同一判定源。

import type { SandboxInfo, SandboxRuntime, SandboxSpec, SandboxForkSpec } from '../src/sandboxes/runtime'

export interface FakeSandboxRecord {
  info: SandboxInfo
  spec: SandboxSpec
  started: boolean
  removed: boolean
}

export class FakeSandboxRuntime implements SandboxRuntime {
  readonly containers = new Map<string, FakeSandboxRecord>()
  readonly networks = new Set<string>()
  readonly removedNetworks: string[] = []
  private idSeq = 0
  // 调用序列（断言 create→seed→start 时序等）
  readonly calls: { kind: string; sessionId?: string; image?: string }[] = []
  // 故障注入：对指定 sessionId 的 createSandbox 抛错
  failCreateFor = new Set<string>()
  // 故障注入：listSandboxes 抛错（测 sweeper 容忍面）
  failList = false
  // fork 字面复制记录（目标 sessionId → 源 sessionId）
  readonly forkedFrom = new Map<string, string>()
  // 故障注入：对指定 sessionId 的 createSandboxFromSource 抛错
  failForkFor = new Set<string>()

  async createNetwork(sessionId: string): Promise<void> {
    this.calls.push({ kind: 'createNetwork', sessionId })
    this.networks.add(sessionId)
  }

  async removeNetwork(sessionId: string): Promise<void> {
    this.calls.push({ kind: 'removeNetwork', sessionId })
    this.networks.delete(sessionId)
    this.removedNetworks.push(sessionId)
  }

  async createSandbox(spec: SandboxSpec): Promise<string> {
    this.calls.push({ kind: 'createSandbox', sessionId: spec.sessionId, image: spec.image })
    if (this.failCreateFor.has(spec.sessionId)) throw new Error(`simulated sandbox create failure: ${spec.sessionId}`)
    const id = `fake-sb-${spec.sessionId}-${this.idSeq++}`
    // created（未启动）状态；容器名带 kind=sandbox 标签语义由 sandboxContainerName 派生
    this.containers.set(spec.sessionId, {
      info: {
        containerId: id,
        sessionId: spec.sessionId,
        running: false,
        status: 'created',
        image: spec.image,
      },
      spec,
      started: false,
      removed: false,
    })
    return id
  }

  // fork 字面复制（#781）：源容器存在 → 落位目标容器（image = 源镜像，字面语义的 fake 面标注）；
  // 源不存在 → 'source-missing'（不建容器，lifecycle 空起步路径兜底）。
  async createSandboxFromSource(spec: SandboxForkSpec): Promise<'copied' | 'source-missing'> {
    this.calls.push({ kind: 'createSandboxFromSource', sessionId: spec.sessionId })
    if (this.failForkFor.has(spec.sessionId)) throw new Error(`simulated sandbox fork failure: ${spec.sessionId}`)
    const source = this.containers.get(spec.sourceSessionId)
    if (!source) return 'source-missing'
    const id = `fake-sb-${spec.sessionId}-${this.idSeq++}`
    this.forkedFrom.set(spec.sessionId, spec.sourceSessionId)
    this.containers.set(spec.sessionId, {
      info: {
        containerId: id,
        sessionId: spec.sessionId,
        running: false,
        status: 'created',
        image: source.info.image,
      },
      spec,
      started: false,
      removed: false,
    })
    return 'copied'
  }

  async getSandbox(sessionId: string): Promise<SandboxInfo | null> {
    return this.containers.get(sessionId)?.info ?? null
  }

  async startSandbox(sessionId: string): Promise<void> {
    this.calls.push({ kind: 'startSandbox', sessionId })
    const rec = this.containers.get(sessionId)
    if (!rec) return
    rec.started = true
    rec.info = { ...rec.info, running: true, status: 'running' }
  }

  async stopSandbox(sessionId: string): Promise<void> {
    this.calls.push({ kind: 'stopSandbox', sessionId })
    const rec = this.containers.get(sessionId)
    if (!rec) return
    rec.info = { ...rec.info, running: false, status: 'exited' }
  }

  async removeSandbox(sessionId: string): Promise<void> {
    this.calls.push({ kind: 'removeSandbox', sessionId })
    const rec = this.containers.get(sessionId)
    if (rec) {
      rec.removed = true
      this.containers.delete(sessionId)
    }
  }

  // 镜像真 daemon：按 kind=sandbox 标签过滤（标签语义在 fake 侧 = 本 map 的全部记录——它们均由
  // createSandbox 以 spec 创建；fleet 容器不进本 map，正如不带 kind 标签不进 daemon 过滤结果）
  async listSandboxes(): Promise<SandboxInfo[]> {
    if (this.failList) throw new Error('simulated daemon unreachable')
    return [...this.containers.values()].map((r) => r.info)
  }
}
