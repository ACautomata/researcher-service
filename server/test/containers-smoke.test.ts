// 集成 smoke（接缝 #5 集成侧）：真 docker daemon + 真 DockerRuntime，端到端验证 create→running→delete。
// **必须真跑，无 skip 门控**（codex PR#346 P2）：daemon 不可达或镜像不可获取 → 套件失败，绝不静默跳过。
// 拉取未缓存镜像经 modem.followProgress 消费进度流（helper 见 smokeDocker.ts）。
// 需 env：OPENCLAW_TEMPLATE_DIR（home 模板源）/ LLM_API_KEY（可注入 dummy，容器未必真调 LLM）。
// #592：本地/CI 编排默认 named volume 拓扑——smoke 走三卷（建容器 → 空卷首挂由镜像内骨架初始化 →
// 删容器连删三卷）。（files CRUD / runOnce smoke 随 T0 #801 files legacy 面与 oneshot 原语退役删除。）

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Docker from 'dockerode'
import { setupTestApp, type TestContext } from './setup'
import { seedUser } from './helpers'
import { FleetDeps } from '../src/containers/deps'
import { Orchestrator } from '../src/containers/orchestrator'
import { DockerRuntime } from '../src/containers/dockerRuntime'
import { InlineLifecycleQueue } from '../src/containers/lifecycleQueue'
import type { FleetConfig } from '../src/containers/values'
import { namedVolumesFor, volumeOrder } from '../src/containers/runtime'
import { DEV_ENCRYPTION_KEYS } from '../src/crypto'
import { ensureImageAvailable, type PullProgressClient } from './smokeDocker'

// #592 三卷拓扑断言 helper：卷存在（inspect 成功）/ 不存在（daemon 404 → reject statusCode 404）
function inspectVolume(name: string): Promise<Docker.VolumeInspectInfo> {
  return new Docker().getVolume(name).inspect()
}

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

// 编排逻辑与镜像内容无关：smoke 默认官方基线，避免「私有派生 GHCR tag 未推/需凭证」的
// 本地前置（派生镜像由 config.ts OPENCLAW_IMAGE 注入 + openclawImage.test.ts 静态断言兜底）。
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
    const cfg: FleetConfig = {
      root: fleetRoot,
      templateDir,
      image: IMAGE,
      llmApiKey: process.env.LLM_API_KEY ?? 'smoke-dummy-key',
      namedVolumes: true, // #592 本地/CI 默认 named volume 拓扑（三卷）
      encryptionKeys: DEV_ENCRYPTION_KEYS,
    }
    runtime = new DockerRuntime()
    const deps = new FleetDeps(runtime, cfg, { queue: new InlineLifecycleQueue() })
    orch = new Orchestrator(deps, ctx.prisma)
    const u = await seedUser(ctx.prisma, 'smoke', 'pw-smoke-secure')
    ownerId = u.id
  }, 240_000)

  afterAll(async () => {
    // best-effort 清理残留容器（beforeAll 中途失败时 runtime/ctx 可能未初始化）。
    // #592：卷名由代系 id 派生、beforeAll 失败时未知，无法连带删卷——残留卷由成功路径
    // delete 连带清理；此兜底只删容器。
    if (runtime) await runtime.remove('smoke-box').catch(() => {})
    if (ctx) await ctx.cleanup()
  })

  it('create → running → delete（真容器端到端，#592 三卷拓扑）', async () => {
    const inst = await orch.createReserve('smoke-box', ownerId)
    expect(inst.status).toBe('creating')
    const volumes = namedVolumesFor(inst.id)
    await orch.createComplete(inst, true)
    const row = await ctx.prisma.container.findUnique({ where: { name: 'smoke-box' } })
    expect(row?.status).toBe('running')
    expect(row?.containerId).not.toBe('')
    // runtime 实况：容器在跑
    const live = await runtime.get('smoke-box')
    expect(live?.running).toBe(true)
    expect(live?.instanceName).toBe('smoke-box')
    // #592 三卷拓扑：容器创建即建三卷（空卷首挂由镜像内骨架初始化；基线镜像为空目录，
    // 内容读写由下方 files CRUD 用例穿卷验证），宿主无 instances/ bind
    for (const v of volumeOrder(volumes)) {
      await expect(inspectVolume(v)).resolves.toBeDefined()
    }
    // delete 端到端：容器 + 三卷连带删除（ADR 0011：remove({v:true}) 只删匿名卷，须显式 rm）
    await orch.delete('smoke-box')
    expect(await ctx.prisma.container.findUnique({ where: { name: 'smoke-box' } })).toBeNull()
    expect(await runtime.get('smoke-box')).toBeNull()
    for (const v of volumeOrder(volumes)) {
      await expect(inspectVolume(v)).rejects.toMatchObject({ statusCode: 404 })
    }
  }, 120_000)

})
