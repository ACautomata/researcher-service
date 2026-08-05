// 编排器测试装配（接缝 #5）：tmp fleet root + 最小模板 + fake runtime + inline queue。
// 每测试独立 tmp 目录（隔离）；templateDir 放最小 home 骨架，templateJson 放最小 openclaw.json 模板。

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PrismaClient } from '../src/generated/prisma/client'
import { FleetDeps, type FleetDepsOverrides } from '../src/containers/deps'
import { Orchestrator } from '../src/containers/orchestrator'
import { InlineLifecycleQueue } from '../src/containers/lifecycleQueue'
import { defaultReservedPorts, type FleetConfig } from '../src/containers/values'
import { DEV_ENCRYPTION_KEYS } from '../src/crypto'
import { FakeRuntime } from './fakeRuntime'

export interface FleetTestContext {
  orch: Orchestrator
  deps: FleetDeps
  runtime: FakeRuntime
  fleetRoot: string
  config: FleetConfig
}

let seq = 0

export function makeFleetTest(
  prisma: PrismaClient,
  overrides: FleetDepsOverrides & { config?: Partial<FleetConfig> } = {},
): FleetTestContext {
  const fleetRoot = mkdtempSync(path.join(tmpdir(), `fleet-test-${process.pid}-${seq++}-`))
  const templateDir = path.join(fleetRoot, 'template')
  mkdirSync(path.join(templateDir, 'workspace'), { recursive: true })
  writeFileSync(path.join(templateDir, 'README.md'), '# home 模板\n')
  const templateJson = path.join(fleetRoot, 'openclaw.template.json')
  writeFileSync(
    templateJson,
    JSON.stringify({ gateway: { auth: {} }, models: { providers: {} } }, null, 2),
  )

  const config: FleetConfig = {
    root: fleetRoot,
    templateDir,
    templateJson,
    image: 'ghcr.io/openclaw/openclaw:test',
    portStart: 19000,
    portEnd: 19010, // 小池便于测耗尽（11 个候选）
    llmApiKey: 'test-llm-key',
    publishHost: '127.0.0.1',
    healthHost: '127.0.0.1',
    panelOrigin: 'http://127.0.0.1:18789', // #385 测试默认与网关 seed 一致
    reservedPorts: defaultReservedPorts(),
    encryptionKeys: DEV_ENCRYPTION_KEYS,
    ...overrides.config,
  }
  const runtime = new FakeRuntime()
  const deps = new FleetDeps(runtime, config, {
    queue: overrides.queue ?? new InlineLifecycleQueue(),
    portInUse: overrides.portInUse ?? (async () => false),
    health: overrides.health ?? { isReachable: async () => true },
    dirRemover: overrides.dirRemover,
    lock: overrides.lock,
    serializer: overrides.serializer,
    onEvict: overrides.onEvict,
    crypto: overrides.crypto,
  })
  const orch = new Orchestrator(deps, prisma)
  return { orch, deps, runtime, fleetRoot, config }
}
