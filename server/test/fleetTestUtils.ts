// 编排器测试装配（接缝 #5）：tmp fleet root + 最小模板 + fake runtime + inline queue。
// 每测试独立 tmp 目录（隔离）；templateDir 放最小 home 骨架。
// T0 #801：端口池/健康探针/openclaw.json 渲染写盘链退役——配置面与 fake 相应收缩。

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PrismaClient } from '../src/generated/prisma/client'
import { FleetDeps, type FleetDepsOverrides } from '../src/containers/deps'
import { Orchestrator } from '../src/containers/orchestrator'
import { InlineLifecycleQueue } from '../src/containers/lifecycleQueue'
import type { FleetConfig } from '../src/containers/values'
import { DEV_ENCRYPTION_KEYS } from '../src/crypto'
import type { FileArchive } from '../src/files/fsPort'
import { FakeRuntime } from './fakeRuntime'

export interface FleetTestContext {
  orch: Orchestrator
  deps: FleetDeps
  runtime: FakeRuntime
  fleetRoot: string
  config: FleetConfig
  // seedWorkspace 灌卷断言点（named volume 拓扑下 createComplete 灌模板 workspace）
  archive: MemoryArchive
}

// 内存 fake FileArchive——编排测试只消费 seedWorkspace（灌卷调用参数与先后顺序断言）；
// 其余方法不实现（本域不触达）。
export class MemoryArchive implements FileArchive {
  // seedWorkspace 调用记录（参数断言）
  readonly seedCalls: Array<{ name: string; hostDir: string }> = []
  // 写盘操作序列（seedWorkspace 时序断言）
  readonly ops: string[] = []
  async seedWorkspace(name: string, hostDir: string): Promise<void> {
    this.seedCalls.push({ name, hostDir })
    this.ops.push('seedWorkspace')
  }
  async readLab(): Promise<never> {
    throw new Error('files lab read not used in fleet tests')
  }
  async readLabBytes(): Promise<never> {
    throw new Error('files lab read not used in fleet tests')
  }
  async writeInContainer(): Promise<never> {
    throw new Error('files write not used in fleet tests')
  }
  async createInContainer(): Promise<never> {
    throw new Error('files create not used in fleet tests')
  }
  async deleteInContainer(): Promise<never> {
    throw new Error('files delete not used in fleet tests')
  }
}

let seq = 0

export function makeFleetTest(
  prisma: PrismaClient,
  overrides: FleetDepsOverrides & { config?: Partial<FleetConfig> } = {},
): FleetTestContext {
  const fleetRoot = mkdtempSync(path.join(tmpdir(), `fleet-test-${process.pid}-${seq++}-`))
  const templateDir = path.join(fleetRoot, 'template')
  mkdirSync(path.join(templateDir, 'workspace', 'skills', 'demo'), { recursive: true })
  writeFileSync(path.join(templateDir, 'README.md'), '# home 模板\n')
  // 模板 workspace 内容（模拟 researcher 各项 md + skills——seedWorkspace 灌卷的源）
  writeFileSync(path.join(templateDir, 'workspace', 'AGENTS.md'), '# workspace 模板\n')
  writeFileSync(path.join(templateDir, 'workspace', 'skills', 'demo', 'SKILL.md'), '# demo skill\n')

  const config: FleetConfig = {
    root: fleetRoot,
    templateDir,
    image: 'ghcr.io/openclaw/openclaw:test',
    llmApiKey: 'test-llm-key',
    namedVolumes: true, // #592 本地/CI 默认 named volume 拓扑（对齐生产；旧 bind 用例显式 false 覆盖）
    encryptionKeys: DEV_ENCRYPTION_KEYS,
    ...overrides.config,
  }
  const runtime = new FakeRuntime()
  const archive: MemoryArchive = overrides.archive === undefined ? new MemoryArchive() : (overrides.archive as MemoryArchive)
  const deps = new FleetDeps(runtime, config, {
    queue: overrides.queue ?? new InlineLifecycleQueue(),
    dirRemover: overrides.dirRemover,
    lock: overrides.lock,
    serializer: overrides.serializer,
    crypto: overrides.crypto,
    archive,
  })
  const orch = new Orchestrator(deps, prisma)
  return { orch, deps, runtime, fleetRoot, config, archive }
}
