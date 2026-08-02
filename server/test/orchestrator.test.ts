import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin } from './helpers'
import { Orchestrator, type OrchestratorConfig } from '../src/orchestrator/orchestrator'
import { FakeRuntime, MemoryQueue, testTokenCrypto } from './fakes'
import { CODE } from '../src/codes'

// 接缝 5：编排器 Port 测试（#334 M2 验收）。
// 注入假 docker（FakeRuntime）+ 内存假 BullMQ（MemoryQueue），断言 5 态机 + 取消标志 +
// 端口入队前分配 + 补偿（bind 冲突换端口重试 / 清理失败标 REMOVING）。无真 daemon / Redis。

let ctx: TestContext
let adminId: string
let dir: string
let queue: MemoryQueue
let runtime: FakeRuntime

function makeCfg(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    fleetRoot: dir,
    templateDir: path.join(dir, 'template'),
    templateJsonPath: path.join(dir, 'tpl.json'),
    image: 'img:tag',
    llmApiKey: 'sk-test',
    portPoolStart: 19000,
    portPoolEnd: 19002, // 小池（3 候选）→ 便于耗尽断言
    gatewayTokenBytes: 32,
    tokenCrypto: testTokenCrypto(),
    portInUse: async () => false,
    ...overrides,
  }
}

function makeOrch(cfg: OrchestratorConfig): Orchestrator {
  return new Orchestrator(ctx.prisma, runtime, queue, cfg)
}

function seedTemplate(): void {
  const template = path.join(dir, 'template')
  mkdirSync(path.join(template, 'workspace'), { recursive: true })
  writeFileSync(path.join(template, 'workspace', 'note.md'), 'hi')
  writeFileSync(path.join(dir, 'tpl.json'), '{}')
}

beforeAll(async () => {
  ctx = await setupTestApp()
  adminId = (await seedAdmin(ctx.prisma)).id
  dir = mkdtempSync(path.join(tmpdir(), `orch-${process.pid}-`))
  queue = new MemoryQueue()
  runtime = new FakeRuntime()
  seedTemplate()
})

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  await ctx.cleanup()
})

// 每测试独立状态：清容器行（释放端口/配额）+ 重置 fake runtime/queue + 重建 instances 目录。
// 对齐旧 backend @django_db 每测试事务回滚语义（避免端口池/配额跨测试累积）。
beforeEach(async () => {
  await ctx.prisma.container.deleteMany({})
  runtime = new FakeRuntime()
  queue = new MemoryQueue()
  rmSync(path.join(dir, 'instances'), { recursive: true, force: true })
})

describe('端口入队前分配（#313）', () => {
  it('取最小空闲端口 + creating 行同步返回', async () => {
    const orch = makeOrch(makeCfg())
    const row = await orch.createReserve('demo', adminId, 3)
    expect(row.status).toBe('creating')
    expect(row.port).toBe(19000)
    expect(row.name).toBe('demo')
    expect(row.ownerId).toBe(adminId)
    // 入队已发生（jobId=name 串行）
    expect(queue.lastCreate('demo').name).toBe('demo')
  })

  it('跳过已用端口（DB 记账 + daemon 宿主端口）', async () => {
    const orch = makeOrch(makeCfg())
    await ctx.prisma.container.create({
      data: {
        name: 'other', port: 19000, ownerId: adminId, token: '', homeDir: '/h',
        image: 'img:tag', status: 'running',
      },
    })
    runtime.containers.set('ext', {
      containerId: 'ext', name: 'ext', running: true, status: 'running',
      image: 'other', port: 19001, instanceName: 'ext',
    })
    const row = await orch.createReserve('demo', adminId, 3)
    expect(row.port).toBe(19002) // 19000 DB 记账 + 19001 daemon → 取 19002
  })

  it('端口池耗尽 → 90004', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('aaa', adminId, 5)
    await orch.createReserve('bbb', adminId, 5)
    await orch.createReserve('ccc', adminId, 5)
    await expect(orch.createReserve('ddd', adminId, 5)).rejects.toMatchObject({ code: CODE.PORT_POOL_EXHAUSTED })
  })

  it('同名撞 → 20041（不分占用者，进程内 Map 互斥）', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('dup', adminId, 5)
    // 并发同名：Map 租约已持有 → 快速失败 20041
    await expect(orch.createReserve('dup', adminId, 5)).rejects.toMatchObject({ code: CODE.NAME_CONFLICT })
  })

  it('超配额 → 20042', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('quota1', adminId, 1) // quota=1 已用满
    await expect(orch.createReserve('quota2', adminId, 1)).rejects.toMatchObject({ code: CODE.QUOTA_EXCEEDED })
  })

  it('codex #5：并发不同名 create 配额原子化——quota=1 恰一个成功', async () => {
    // check-then-insert 竞态：count 与 insert 同事务（SQLite 串行化写事务），并发不同名不会都
    // 读到 count<1。Promise.all 并发，恰一个成功一个 20042。
    const orch = makeOrch(makeCfg())
    const results = await Promise.allSettled([
      orch.createReserve('conc1', adminId, 1),
      orch.createReserve('conc2', adminId, 1),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const err = (rejected[0] as PromiseRejectedResult).reason
    expect(err).toMatchObject({ code: CODE.QUOTA_EXCEEDED })
  })
})

describe('5 态机 + provisioning（creating→running）', () => {
  it('provisionCreate → running + containerId + home/config 落盘', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('demo', adminId, 3)
    const job = queue.lastCreate('demo')
    await orch.provisionCreate(job.name, job.configText)
    const after = await ctx.prisma.container.findUnique({ where: { name: 'demo' } })
    expect(after!.status).toBe('running')
    expect(after!.containerId).toContain('fakeid-demo-')
    // home 已 provision（cp 模板）+ config 已渲染（占位 token）
    expect(existsSync(path.join(dir, 'instances', 'demo', 'home', 'workspace', 'note.md'))).toBe(true)
    const cfgText = await import('node:fs').then((f) => f.readFileSync(path.join(dir, 'instances', 'demo', 'openclaw.json'), 'utf8'))
    expect(cfgText).toContain('${GATEWAY_TOKEN}')
    // 租约已释放
    expect(orch['leases'].isHeld('demo')).toBe(false)
  })

  it('GATEWAY_TOKEN 密文落库（tokenEncrypted=true，明文不入库）', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('tokenc', adminId, 3)
    const row = await ctx.prisma.container.findUnique({ where: { name: 'tokenc' } })
    expect(row!.tokenEncrypted).toBe(true)
    // 密文格式 base64.iv.base64.tag.base64.ct（非明文 base64url token）
    expect(row!.token).toMatch(/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/)
    // 明文 token 不入库（解密后 ≠ 密文，且密文不含原 token）
    const decrypted = testTokenCrypto().decrypt(row!.token)
    expect(decrypted).not.toBe(row!.token)
    expect(decrypted.length).toBeGreaterThanOrEqual(32)
    // provision 时注入 runtime 的是解密后的真 token
    await orch.provisionCreate(queue.lastCreate('tokenc').name, queue.lastCreate('tokenc').configText)
    const runSpec = runtime.runSpecs.find((s) => s.name === 'tokenc')!
    expect(runSpec.gatewayToken).toBe(decrypted)
  })

  it('bind 冲突就地换端口重试（预算=池大小）', async () => {
    runtime.failBindPorts = new Set([19000]) // 19000 被宿主进程占用
    const orch = makeOrch(makeCfg())
    const row = await orch.createReserve('bind1', adminId, 3)
    expect(row.port).toBe(19000) // 探测不可见 → 先选 19000
    const job = queue.lastCreate('bind1')
    await orch.provisionCreate(job.name, job.configText)
    const after = await ctx.prisma.container.findUnique({ where: { name: 'bind1' } })
    expect(after!.status).toBe('running')
    expect(after!.port).toBe(19001) // 冲突后重试到 19001
    expect(runtime.runSpecs[0].hostPort).toBe(19000)
    expect(runtime.runSpecs[1].hostPort).toBe(19001)
  })

  it('provision 失败 → 保留 ERROR 行（补偿）', async () => {
    runtime.failBindPorts = new Set([19000, 19001, 19002]) // 池内全冲突 → 耗尽
    const orch = makeOrch(makeCfg())
    await orch.createReserve('efail', adminId, 3)
    const job = queue.lastCreate('efail')
    await orch.provisionCreate(job.name, job.configText)
    const after = await ctx.prisma.container.findUnique({ where: { name: 'efail' } })
    expect(after!.status).toBe('error') // 行保留（客户端经 list + delete 感知）
  })
})

describe('取消标志（delete 遇在飞 create）', () => {
  it('检查点检出 cancelRequested → 回滚后终止（不建目录/不 run）', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('cancel', adminId, 3)
    // delete 在飞 create：置取消标志（路由层 deleteEnqueue 的 creating 分支，不入队 delete——
    // 同名 create job 仍活跃，jobId 重复会被 BullMQ 拒收；检查点回滚即终止）
    await orch.deleteEnqueue('cancel', adminId)
    const row = await ctx.prisma.container.findUnique({ where: { name: 'cancel' } })
    expect(row!.cancelRequested).toBe(true)
    // provisioning 检查点检出 → 回滚删行
    const createJob = queue.lastCreate('cancel')
    await orch.provisionCreate(createJob.name, createJob.configText)
    const after = await ctx.prisma.container.findUnique({ where: { name: 'cancel' } })
    expect(after).toBeNull() // 行已回滚
    expect(runtime.runSpecs.filter((s) => s.name === 'cancel')).toHaveLength(0) // 未 run
    expect(existsSync(path.join(dir, 'instances', 'cancel'))).toBe(false) // 未建目录
  })

  it('run 后取消 → 立即自删', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('run2', adminId, 3)
    const createJob = queue.lastCreate('run2')
    // 先让 create 跑完（status=running），随后 delete 入队
    await orch.provisionCreate(createJob.name, createJob.configText)
    expect((await ctx.prisma.container.findUnique({ where: { name: 'run2' } }))!.status).toBe('running')
    await orch.deleteEnqueue('run2', adminId)
    await orch.provisionDelete(queue.lastDelete('run2').name)
    const after = await ctx.prisma.container.findUnique({ where: { name: 'run2' } })
    expect(after).toBeNull()
  })
})

describe('异步 delete（removing 终态）', () => {
  it('deleteEnqueue 返回后行仍在（未删）→ provisionDelete 后 removing→消失', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('del', adminId, 3)
    await orch.provisionCreate(queue.lastCreate('del').name, queue.lastCreate('del').configText)
    // delete 变异步：入队立即返回（行仍在，list 轮询观察 removing）
    await orch.deleteEnqueue('del', adminId)
    expect((await ctx.prisma.container.findUnique({ where: { name: 'del' } }))).not.toBeNull()
    // worker 执行：stop/remove + rmtree + 删行
    await orch.provisionDelete(queue.lastDelete('del').name)
    expect(await ctx.prisma.container.findUnique({ where: { name: 'del' } })).toBeNull()
    expect(runtime.removed).toContain('del')
    expect(existsSync(path.join(dir, 'instances', 'del'))).toBe(false)
  })

  it('清理失败 → 标 REMOVING + 抛 20045（可重试）', async () => {
    const orch = makeOrch(makeCfg({ dirRemover: async () => { throw new Error('permission denied') } }))
    await orch.createReserve('cln', adminId, 3)
    await orch.provisionCreate(queue.lastCreate('cln').name, queue.lastCreate('cln').configText)
    await orch.deleteEnqueue('cln', adminId)
    await expect(orch.provisionDelete(queue.lastDelete('cln').name)).rejects.toMatchObject({
      code: CODE.CLEANUP_FAILED,
    })
    const row = await ctx.prisma.container.findUnique({ where: { name: 'cln' } })
    expect(row!.status).toBe('removing') // 可重试
  })

  it('codex #3：delete 前容器内 chown home 给 host uid（root 属主 EACCES 防护）', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('own', adminId, 3)
    await orch.provisionCreate(queue.lastCreate('own').name, queue.lastCreate('own').configText)
    await orch.deleteEnqueue('own', adminId)
    await orch.provisionDelete(queue.lastDelete('own').name)
    // chown 在 stop/remove 之前执行（容器还在、有 root 权限）
    const chowns = runtime.execCalls.filter(
      ([name, cmd]) => name === 'own' && cmd[0] === 'chown' && cmd[1] === '-R',
    )
    expect(chowns).toHaveLength(1)
    const chownCmd = chowns[0][1]
    expect(chownCmd[2]).toMatch(/^\d+$/) // host uid
    expect(chownCmd[3]).toBe('/home/node/.openclaw') // HOME_BIND
    // chown 先于 stop/remove
    expect(runtime.stopped).toContain('own')
    expect(runtime.removed).toContain('own')
  })

  it('删除不存在的容器 → 幂等 no-op', async () => {
    const orch = makeOrch(makeCfg())
    await expect(orch.deleteEnqueue('nope', adminId)).rejects.toMatchObject({ code: CODE.CONTAINER_NOT_FOUND })
    await orch.provisionDelete('nope') // worker 幂等
  })
})

describe('同名列串行化 + 租约', () => {
  it('createReserve 期间同名列被 Map 互斥挡下（20041）', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('ser', adminId, 5)
    expect(orch['leases'].isHeld('ser')).toBe(true) // provisioning 在飞 → 租约持有
    await expect(orch.createReserve('ser', adminId, 5)).rejects.toMatchObject({ code: CODE.NAME_CONFLICT })
    // 释放后（provision 完成）可重建
    await orch.provisionCreate(queue.lastCreate('ser').name, queue.lastCreate('ser').configText)
    expect(orch['leases'].isHeld('ser')).toBe(false)
    await orch.createReserve('ser2', adminId, 5)
  })
})
