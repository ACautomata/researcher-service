import type { ContainerInfo, ContainerRuntime, ContainerSpec } from '../src/orchestrator/dockerRuntime'
import type { ProvisionJobQueue } from '../src/orchestrator/orchestrator'
import { createTokenCrypto, type TokenCrypto } from '../src/orchestrator/tokenCrypto'

// 接缝 5 测试替身（对齐 backend/containers/tests/fakes.py）：假 docker + 内存假 BullMQ。
// 记录调用、模拟 daemon 状态；无需 docker daemon / Redis。

// 测试用固定 tokenCrypto（同一 secret 可逆）；与生产 createTokenCrypto(JWT_SECRET) 同实现。
export function testTokenCrypto(): TokenCrypto {
  return createTokenCrypto('test-token-crypto-secret')
}

export class FakeRuntime implements ContainerRuntime {
  // name → ContainerInfo（模拟 daemon 里的容器）
  containers: Map<string, ContainerInfo> = new Map()
  runSpecs: ContainerSpec[] = []
  stopped: string[] = []
  removed: string[] = []
  execCalls: Array<[string, string[]]> = []
  // 模拟宿主非 Docker 进程占池端口 → docker run bind 冲突（近似 docker.errors.APIError）
  failBindPorts: Set<number> = new Set()
  // 模拟 remove 可注入失败（daemon 瞬态错误）
  failRemove = false
  // 模拟 daemon 抖动：runtime.get 抛错
  failGet = false
  private next = 0

  async run(spec: ContainerSpec): Promise<string> {
    this.runSpecs.push(spec)
    if (this.failBindPorts.has(spec.hostPort)) {
      throw new Error(
        `Bind for 0.0.0.0:${spec.hostPort} failed: port is already allocated`,
      )
    }
    const cid = `fakeid-${spec.name}-${this.next++}`
    this.containers.set(spec.name, {
      containerId: cid,
      name: `openclaw-gw-${spec.name}`,
      running: true,
      status: 'running',
      image: spec.image,
      port: spec.hostPort,
      instanceName: spec.name,
    })
    return cid
  }

  async get(name: string): Promise<ContainerInfo | null> {
    if (this.failGet) throw new Error('daemon unavailable')
    return this.containers.get(name) ?? null
  }

  async stop(name: string): Promise<void> {
    const info = this.containers.get(name)
    if (!info) return
    this.containers.set(name, { ...info, running: false, status: 'exited' })
    this.stopped.push(name)
  }

  async remove(name: string): Promise<void> {
    if (this.failRemove) throw new Error('daemon transient error')
    this.containers.delete(name)
    this.removed.push(name)
  }

  async listFleet(): Promise<ContainerInfo[]> {
    return [...this.containers.values()]
  }

  async hostPublishedPorts(): Promise<Set<number>> {
    const ports = new Set<number>()
    for (const info of this.containers.values()) {
      if (info.port != null) ports.add(info.port)
    }
    return ports
  }

  async execSync(_name: string, cmd: string[]): Promise<void> {
    this.execCalls.push([_name, cmd])
  }
}

export type ProvisionJob = { type: 'create'; name: string; ownerId: string; configText: string } | {
  type: 'delete'
  name: string
  ownerId: string
}

// 内存假 BullMQ：记录入队 job；测试手动 runDirect 模拟 worker 消费（stalled-job 语义归 BullMQ，不测）。
export class MemoryQueue implements ProvisionJobQueue {
  jobs: ProvisionJob[] = []
  failEnqueueDelete = false // codex #6：模拟 Redis 挂 → enqueueDelete 抛错

  async enqueueCreate(name: string, ownerId: string, configText: string): Promise<void> {
    this.jobs.push({ type: 'create', name, ownerId, configText })
  }

  async enqueueDelete(name: string, ownerId: string): Promise<void> {
    if (this.failEnqueueDelete) throw new Error('redis down')
    this.jobs.push({ type: 'delete', name, ownerId })
  }

  async close(): Promise<void> {}

  /** 取最后一个入队的指定 type job（createReserve 后消费） */
  lastCreate(name: string): ProvisionJob & { type: 'create' } {
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const j = this.jobs[i]
      if (j.type === 'create' && j.name === name) return j
    }
    throw new Error(`no create job for ${name}`)
  }

  lastDelete(name: string): ProvisionJob & { type: 'delete' } {
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const j = this.jobs[i]
      if (j.type === 'delete' && j.name === name) return j
    }
    throw new Error(`no delete job for ${name}`)
  }
}
