import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin } from './helpers'
import { Orchestrator } from '../src/orchestrator/orchestrator'
import { MemoryQueue, testTokenCrypto } from './fakes'
import { DockerRuntime } from '../src/orchestrator/dockerRuntime'

// 集成 smoke（门控）：真 docker daemon 才跑（自动探测门控，对齐旧 backend）。默认 skip。
// 自动探测：DOCKER_SMOKE=1 强制跑；未设时若 `docker info` 可达也跑（探测失败静默 skip）。

function dockerDaemonAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

const RUN_SMOKE = process.env.DOCKER_SMOKE === '1' || dockerDaemonAvailable()
const describeSmoke = RUN_SMOKE ? describe : describe.skip

describeSmoke('containers 编排集成 smoke（真 docker daemon）', () => {
  let ctx: TestContext
  let dir: string
  let ownerId: string

  beforeAll(async () => {
    ctx = await setupTestApp()
    ownerId = (await seedAdmin(ctx.prisma)).id
    dir = mkdtempSync(path.join(tmpdir(), `smoke-${process.pid}-`))
    mkdirSync(path.join(dir, 'template', 'workspace'), { recursive: true })
    writeFileSync(path.join(dir, 'template', 'workspace', 'note.md'), 'hi')
    writeFileSync(path.join(dir, 'tpl.json'), '{}')
  })

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true })
    await ctx.cleanup()
  })

  it('create → running → delete → removed（真实链路）', async () => {
    const queue = new MemoryQueue()
    const runtime = new DockerRuntime('127.0.0.1')
    const orch = new Orchestrator(ctx.prisma, runtime, queue, {
      fleetRoot: dir,
      templateDir: path.join(dir, 'template'),
      templateJsonPath: path.join(dir, 'tpl.json'),
      image: process.env.OPENCLAW_IMAGE ?? 'ghcr.io/openclaw/openclaw:2026.7.1-browser',
      llmApiKey: 'sk-smoke-test',
      portPoolStart: 19000,
      portPoolEnd: 19050,
      gatewayTokenBytes: 32,
      tokenCrypto: testTokenCrypto(),
    })
    const name = `smoke-${Date.now() % 100000}-${Math.floor(Math.random() * 1000)}` // 防并行 CI 撞名
    await orch.createReserve(name, ownerId, 3)
    const job = queue.lastCreate(name)
    await orch.provisionCreate(job.name, job.configText)
    const running = await ctx.prisma.container.findUnique({ where: { name } })
    expect(running!.status).toBe('running')
    expect(running!.containerId).toBeTruthy()
    // 删除
    await orch.provisionDelete(name)
    expect(await ctx.prisma.container.findUnique({ where: { name } })).toBeNull()
  }, 420_000)
})
