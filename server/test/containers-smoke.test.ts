// 集成 smoke（接缝 #5 集成侧）：真 docker daemon + 真 DockerRuntime，端到端验证 create→running→delete。
// **默认 skip，自动探测门控**（spec Testing Decisions #5：「集成 smoke 需真 docker daemon 默认 skip
// （自动探测门控，对齐 backend/README.md）」）。daemon 不可达 → 整文件 skip；可达 → 真跑。
// 需 env：OPENCLAW_TEMPLATE_DIR（home 模板源）/ LLM_API_KEY（可注入 dummy，容器未必真调 LLM）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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

// 自动探测 docker daemon（listImages 快速失败即判不可达）。
async function dockerReachable(): Promise<boolean> {
  try {
    const Docker = (await import('dockerode')).default
    const d = new Docker()
    await d.ping()
    return true
  } catch {
    return false
  }
}

// 镜像可获取（本地已有 or 拉取成功）：拉取失败（registry 404 / 网络 / 超时）→ 判不可用。
// 门控从「仅 daemon 可达」扩展到「镜像可获取」：daemon 在跑但 OPENCLAW_IMAGE 指向已退役 tag
// （registry 404）时，测试应优雅 skip 而非以 pull 失败中断整个套件（回归：镜像 tag 曾变更）。
async function imageObtainable(image: string): Promise<boolean> {
  try {
    const Docker = (await import('dockerode')).default
    const d = new Docker()
    try {
      await d.getImage(image).inspect() // 本地已缓存 → 就绪
      return true
    } catch {
      /* 本地缺失 → 尝试拉取 */
    }
    const stream = await d.pull(image)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('image pull timeout')), 120_000)
      stream.on('end', () => { clearTimeout(timer); resolve() })
      stream.on('error', (e) => { clearTimeout(timer); reject(e) })
    })
    return true
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`[smoke] 镜像不可获取（daemon 可达但 image 拉取失败），skip 集成 smoke: ${image}`)
    return false
  }
}

const IMAGE = process.env.OPENCLAW_IMAGE ?? 'ghcr.io/openclaw/openclaw:2026.7.1-browser'

// 探测挪进 beforeAll（tsconfig module=commonjs 不允许顶层 await，否则 tsc --noEmit 红线）。
describe('containers 集成 smoke（真 docker daemon）', () => {
  let daemonUp = false
  let imageReady = false
  let ctx: TestContext
  let orch: Orchestrator
  let runtime: DockerRuntime
  let fleetRoot: string
  let ownerId: string

  beforeAll(async () => {
    daemonUp = await dockerReachable()
    if (!daemonUp) return // daemon 不可达 → 用例内 skip（CI 无 daemon 不阻塞）
    imageReady = await imageObtainable(IMAGE)
    if (!imageReady) return // 镜像不可获取 → 用例内 skip（自动配置门控，不中断套件）
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
    if (!daemonUp || !imageReady) return
    // best-effort 清理残留容器
    await runtime.remove('smoke-box').catch(() => {})
    await ctx.cleanup()
  })

  it('create → running → delete（真容器端到端）', async (tctx) => {
    if (!daemonUp || !imageReady) tctx.skip()
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
