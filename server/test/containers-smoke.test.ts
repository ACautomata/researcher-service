// 集成 smoke（接缝 #5 集成侧）：真 docker daemon + 真 DockerRuntime，端到端验证 create→running→delete。
// **必须真跑，无 skip 门控**（codex PR#346 P2）：daemon 不可达或镜像不可获取 → 套件失败，绝不静默跳过。
// 拉取未缓存镜像经 modem.followProgress 消费进度流（helper 见 smokeDocker.ts，与 pairingSmoke 共享）。
// 需 env：OPENCLAW_TEMPLATE_DIR（home 模板源）/ LLM_API_KEY（可注入 dummy，容器未必真调 LLM）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setupTestApp, type TestContext } from './setup'
import { seedUser } from './helpers'
import { FleetDeps } from '../src/containers/deps'
import { Orchestrator } from '../src/containers/orchestrator'
import { DockerRuntime } from '../src/containers/dockerRuntime'
import { InlineLifecycleQueue } from '../src/containers/lifecycleQueue'
import { defaultReservedPorts, type FleetConfig } from '../src/containers/values'
import { DEV_ENCRYPTION_KEYS } from '../src/crypto'
import { ensureImageAvailable, type PullProgressClient } from './smokeDocker'

describe('ensureImageAvailable / drainPull（pull progress 消费，codex PR#346 P2）', () => {
  const modemWith = (err: Error | null): PullProgressClient['modem'] => ({
    followProgress: (_s, f) => f(err),
  })

  it('本地已缓存 → 就绪，不触发 pull', async () => {
    let pulled = false
    const client: PullProgressClient = {
      getImage: () => ({ inspect: async () => ({}) }),
      pull: async () => {
        pulled = true
        return new Readable()
      },
      modem: modemWith(null),
    }
    await expect(ensureImageAvailable('img', client)).resolves.toBeUndefined()
    expect(pulled).toBe(false)
  })

  it('pull 失败（followProgress 回调 err，注册表错误以进度记录出现）→ 抛错（不判就绪）', async () => {
    const client: PullProgressClient = {
      getImage: () => ({ inspect: async () => { throw { statusCode: 404 } } }),
      pull: async () => new Readable(),
      modem: modemWith(new Error('pull failed')),
    }
    await expect(ensureImageAvailable('img', client)).rejects.toThrow('pull failed')
  })

  it('pull 成功（followProgress 回调 null）→ 就绪', async () => {
    const client: PullProgressClient = {
      getImage: () => ({ inspect: async () => { throw { statusCode: 404 } } }),
      pull: async () => new Readable(),
      modem: modemWith(null),
    }
    await expect(ensureImageAvailable('img', client)).resolves.toBeUndefined()
  })
})

const IMAGE = process.env.OPENCLAW_IMAGE ?? 'ghcr.io/openclaw/openclaw:2026.7.1-browser'

describe('containers 集成 smoke（真 docker daemon）', () => {
  let ctx: TestContext
  let orch: Orchestrator
  let runtime: DockerRuntime
  let fleetRoot: string
  let ownerId: string

  beforeAll(async () => {
    // 必须真跑：镜像不可获取（含退役 tag）→ 这里抛错、套件失败，绝不以 skip 掩盖（codex PR#346 P2）。
    await ensureImageAvailable(IMAGE)
    ctx = await setupTestApp()
    fleetRoot = mkdtempSync(path.join(tmpdir(), `fleet-smoke-${process.pid}-`))
    const templateDir = process.env.OPENCLAW_TEMPLATE_DIR ?? path.join(fleetRoot, 'template')
    if (!process.env.OPENCLAW_TEMPLATE_DIR) {
      mkdirSync(path.join(templateDir, 'workspace'), { recursive: true })
      writeFileSync(path.join(templateDir, 'README.md'), '# smoke home\n')
    }
    const templateJson = path.join(fleetRoot, 'openclaw.template.json')
    writeFileSync(templateJson, JSON.stringify({ gateway: { auth: {} }, models: { providers: {} } }))

    const cfg: FleetConfig = {
      root: fleetRoot,
      templateDir,
      templateJson,
      image: IMAGE,
      portStart: 19700,
      portEnd: 19710,
      llmApiKey: process.env.LLM_API_KEY ?? 'smoke-dummy-key',
      publishHost: '127.0.0.1',
      healthHost: '127.0.0.1',
      reservedPorts: defaultReservedPorts(),
      encryptionKeys: DEV_ENCRYPTION_KEYS,
    }
    runtime = new DockerRuntime(undefined, cfg.publishHost)
    const deps = new FleetDeps(runtime, cfg, { queue: new InlineLifecycleQueue() })
    orch = new Orchestrator(deps, ctx.prisma)
    const u = await seedUser(ctx.prisma, 'smoke', 'pw-smoke-secure')
    ownerId = u.id
  }, 240_000)

  afterAll(async () => {
    // best-effort 清理残留容器（beforeAll 中途失败时 runtime/ctx 可能未初始化）
    if (runtime) await runtime.remove('smoke-box').catch(() => {})
    if (ctx) await ctx.cleanup()
  })

  it('create → running → delete（真容器端到端）', async () => {
    const inst = await orch.createReserve('smoke-box', ownerId)
    expect(inst.status).toBe('creating')
    expect(inst.port).toBeGreaterThanOrEqual(19700)
    await orch.createComplete(inst, true)
    const row = await ctx.prisma.container.findUnique({ where: { name: 'smoke-box' } })
    expect(row?.status).toBe('running')
    expect(row?.containerId).not.toBe('')
    // runtime 实况：容器在跑
    const live = await runtime.get('smoke-box')
    expect(live?.running).toBe(true)
    expect(live?.instanceName).toBe('smoke-box')
    // delete 端到端
    await orch.delete('smoke-box')
    expect(await ctx.prisma.container.findUnique({ where: { name: 'smoke-box' } })).toBeNull()
    expect(await runtime.get('smoke-box')).toBeNull()
  }, 120_000)
})
