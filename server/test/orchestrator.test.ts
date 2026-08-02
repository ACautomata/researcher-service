import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser } from './helpers'
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
  it('DB lease 被持（另一进程在飞 create）→ deleteEnqueue 置取消标志，检查点回滚后终止', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('cancel', adminId, 3)
    // 模拟另一进程正在 provisioning（DB lease 被持）——deleteEnqueue 的进程内 lease 已随 enqueue
    // 释放（codex 五轮 #1），但 deleteEnqueue 查 DB 发现 creating + lease 被持 → 置取消标志
    await ctx.prisma.container.update({
      where: { name: 'cancel' },
      data: { leaseExpiresAt: new Date(Date.now() + 60_000) },
    })
    await orch.deleteEnqueue('cancel', adminId)
    const row = await ctx.prisma.container.findUnique({ where: { name: 'cancel' } })
    expect(row!.cancelRequested).toBe(true)
    // provisioning 检查点检出 → 回滚删行
    const createJob = queue.lastCreate('cancel')
    // 释放 lease（模拟原 worker 崩溃后过期）再跑 create（检查点 1 检出 cancelRequested → 终止）
    await ctx.prisma.container.update({ where: { name: 'cancel' }, data: { leaseExpiresAt: null } })
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

  it('codex 二轮 P1：chown 失败保留容器（不删）+ 行 REMOVING 可重试', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('chownf', adminId, 3)
    await orch.provisionCreate(queue.lastCreate('chownf').name, queue.lastCreate('chownf').configText)
    await orch.deleteEnqueue('chownf', adminId)
    runtime.failExecSync = true // chown 失败（容器在跑但命令错）
    await expect(orch.provisionDelete(queue.lastDelete('chownf').name)).rejects.toMatchObject({
      code: CODE.CLEANUP_FAILED,
    })
    // 容器保留（未 stop/remove——唯一能回收 root 属主文件的环境不能丢）
    expect(runtime.stopped).not.toContain('chownf')
    expect(runtime.removed).not.toContain('chownf')
    expect(runtime.containers.has('chownf')).toBe(true)
    // 行 REMOVING（可重试）
    const row = await ctx.prisma.container.findUnique({ where: { name: 'chownf' } })
    expect(row!.status).toBe('removing')
  })

  it('codex 二轮 P1：跨 worker DB CAS——并发 provisionDelete 恰一个执行', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('dupdel', adminId, 3)
    await orch.provisionCreate(queue.lastCreate('dupdel').name, queue.lastCreate('dupdel').configText)
    await orch.deleteEnqueue('dupdel', adminId)
    const delJob = queue.lastDelete('dupdel')
    // 两个 worker 并发 delete 同名：DB CAS 租约恰一个 claim，另一个抛 LeaseContentionError（retryable，
    // codex 四轮 #2——不 no-op，否则 delete 请求丢失）。最终行被删、removed 恰一次。
    const results = await Promise.allSettled([
      orch.provisionDelete(delJob.name, delJob.rowId),
      orch.provisionDelete(delJob.name, delJob.rowId),
    ])
    const rejected = results.filter((r) => r.status === 'rejected')
    if (rejected.length > 0) {
      // 并发竞争：一方 LeaseContention → 重试后可回收
      expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain('lease held')
      await orch.provisionDelete(delJob.name, delJob.rowId)
    }
    expect(await ctx.prisma.container.findUnique({ where: { name: 'dupdel' } })).toBeNull()
    expect(runtime.removed.filter((n) => n === 'dupdel')).toHaveLength(1)
  })

  it('删除不存在的容器 → 幂等 no-op', async () => {
    const orch = makeOrch(makeCfg())
    await expect(orch.deleteEnqueue('nope', adminId)).rejects.toMatchObject({ code: CODE.CONTAINER_NOT_FOUND })
    await orch.provisionDelete('nope') // worker 幂等
  })

  it('codex 四轮 P1 #1：rowId 绑定——delete 重试不误删新重建的同名行', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('rbind', adminId, 3)
    await orch.provisionCreate(queue.lastCreate('rbind').name, queue.lastCreate('rbind').configText)
    await orch.deleteEnqueue('rbind', adminId)
    const oldJob = queue.lastDelete('rbind')
    // 模拟：delete job 消费前，同名行被删 + 新用户重建（新 rowId）
    await orch.provisionDelete('rbind')
    await orch.createReserve('rbind', adminId, 3)
    await orch.provisionCreate(queue.lastCreate('rbind').name, queue.lastCreate('rbind').configText)
    // 旧 delete job 重试（old rowId）→ 不得误删新行
    await orch.provisionDelete('rbind', oldJob.rowId)
    expect(await ctx.prisma.container.findUnique({ where: { name: 'rbind' } })).not.toBeNull() // 新行保留
  })

  it('codex 四轮 P1 #3：残留 orphan 目录 → createReserve 同步拒绝（20044）', async () => {
    const orch = makeOrch(makeCfg())
    // 模拟 DB 无行但 instances/<name> 残留（崩溃/手动清 DB）
    await import('node:fs/promises').then((f) => f.mkdir(path.join(dir, 'instances', 'orphan'), { recursive: true }))
    // reservation 同步拒绝（POST 前暴露，不留无主 creating 行）
    await expect(orch.createReserve('orphan', adminId, 3)).rejects.toMatchObject({ code: CODE.ORPHAN_DIR })
    expect(await ctx.prisma.container.findUnique({ where: { name: 'orphan' } })).toBeNull() // 未建行
  })

  it('codex 五轮 P1 #4：deleteEnqueue 归属二次校验——ownerId 不匹配 → 20040 不误删重建行', async () => {
    const orch = makeOrch(makeCfg())
    // admin 建行
    await orch.createReserve('ownerchk', adminId, 3)
    // 模拟：行被删 + 另一用户（user2）重建同名——原 admin 的 deleteEnqueue 应拒（ownerId 不匹配）
    await ctx.prisma.container.deleteMany({ where: { name: 'ownerchk' } })
    const other = await seedUser(ctx.prisma, 'userX', 'pw-userx-secure')
    await orch.createReserve('ownerchk', other.id, 3)
    // admin 再删 → 20040（行已属 userX，不误删）
    await expect(orch.deleteEnqueue('ownerchk', adminId)).rejects.toMatchObject({ code: CODE.CONTAINER_NOT_FOUND })
    // userX 的行未被误删
    expect(await ctx.prisma.container.findUnique({ where: { name: 'ownerchk' } })).not.toBeNull()
  })

  it('codex 五轮 P1 #1/#2：delete claim 原子绑定 rowId——重建行不被旧 delete claim', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('claimbind', adminId, 3)
    await orch.provisionCreate(queue.lastCreate('claimbind').name, queue.lastCreate('claimbind').configText)
    await orch.deleteEnqueue('claimbind', adminId)
    const oldRow = await ctx.prisma.container.findUnique({ where: { name: 'claimbind' } })
    // 模拟：行被删 + 重建（新 rowId）——清目录避免 orphan 拒绝
    await ctx.prisma.container.deleteMany({ where: { name: 'claimbind' } })
    await import('node:fs/promises').then((f) => f.rm(path.join(dir, 'instances', 'claimbind'), { recursive: true, force: true }))
    await orch.createReserve('claimbind', adminId, 3)
    // 旧 delete job（old rowId）claim → CAS 谓词含 id: oldRowId → 匹配不到新行 → no-op
    await orch.provisionDelete('claimbind', oldRow!.id)
    expect(await ctx.prisma.container.findUnique({ where: { name: 'claimbind' } })).not.toBeNull() // 新行未被删
  })
})

describe('同名列串行化 + 租约', () => {
  it('createReserve 后进程内 lease 已释放（enqueue 即释放，codex 五轮 #1）；撞名由 DB unique 仲裁 20041', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('ser', adminId, 5)
    // 进程内 lease 已随 enqueue 释放（worker 串行靠 DB lease，请求侧不留）
    expect(orch['leases'].isHeld('ser')).toBe(false)
    // 同名创建仍被拒（20041——DB name@unique，insertCreatingRow P2002 转译）
    await expect(orch.createReserve('ser', adminId, 5)).rejects.toMatchObject({ code: CODE.NAME_CONFLICT })
    await orch.createReserve('ser2', adminId, 5)
  })

  it('codex 三轮 P1 #1：租约被持有 → provisionCreate 抛 LeaseContention（可重试，非 no-op）', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('cont', adminId, 5)
    // 模拟另一 worker 持有 DB lease（崩溃后在飞）：行 creating + lease 未过期
    await ctx.prisma.container.update({
      where: { name: 'cont' },
      data: { leaseExpiresAt: new Date(Date.now() + 60_000) },
    })
    // 重指派 worker 抢占失败 → 抛 LeaseContentionError（BullMQ 据此重试，不移除 job）
    await expect(orch.provisionCreate(queue.lastCreate('cont').name, queue.lastCreate('cont').configText))
      .rejects.toThrow(/lease held/)
    // 行仍在 creating（未被删/未误收敛）
    const row = await ctx.prisma.container.findUnique({ where: { name: 'cont' } })
    expect(row!.status).toBe('creating')
    // lease 过期后重试可抢占成功（清空 lease 模拟过期）
    await ctx.prisma.container.update({ where: { name: 'cont' }, data: { leaseExpiresAt: null } })
    await orch.provisionCreate(queue.lastCreate('cont').name, queue.lastCreate('cont').configText)
    expect((await ctx.prisma.container.findUnique({ where: { name: 'cont' } }))!.status).toBe('running')
  })

  it('codex 三轮 P1 #3：removing + lease 过期 → provisionDelete 可回收（不永久卡）', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('recl', adminId, 3)
    await orch.provisionCreate(queue.lastCreate('recl').name, queue.lastCreate('recl').configText)
    // 模拟上次 delete 失败：行 removing + lease 已过期（>5min TTL）
    await ctx.prisma.container.update({
      where: { name: 'recl' },
      data: { status: 'removing', leaseExpiresAt: new Date(Date.now() - 60_000) },
    })
    // 重试 delete → 可回收（removing + lease 过期 = 可 reclaim）
    await orch.provisionDelete('recl')
    expect(await ctx.prisma.container.findUnique({ where: { name: 'recl' } })).toBeNull()
  })

  it('review finding 1：removing + lease=null → provisionDelete 可回收（不永久卡）', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('reclnull', adminId, 3)
    await orch.provisionCreate(queue.lastCreate('reclnull').name, queue.lastCreate('reclnull').configText)
    // 模拟：上一个 worker claim 后崩溃，finally 把 lease 清成 null 但行未删（removing + lease=null）
    await ctx.prisma.container.update({
      where: { name: 'reclnull' },
      data: { status: 'removing', leaseExpiresAt: null },
    })
    await orch.provisionDelete('reclnull')
    expect(await ctx.prisma.container.findUnique({ where: { name: 'reclnull' } })).toBeNull()
  })

  it('review finding 2：容器已停止（chown exec 409）→ 跳过 chown 继续删除', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('chown409', adminId, 3)
    await orch.provisionCreate(queue.lastCreate('chown409').name, queue.lastCreate('chown409').configText)
    // 容器已停止（unless-stopped 常态）→ exec chown 返回 409 Conflict
    runtime.execSync409 = true
    await orch.deleteEnqueue('chown409', adminId)
    await orch.provisionDelete(queue.lastDelete('chown409').name)
    // 跳过 chown 仍删除成功（409 不视为可重试错误）
    expect(await ctx.prisma.container.findUnique({ where: { name: 'chown409' } })).toBeNull()
  })

  it('review finding 5：容器归属不匹配（同名被重建）→ 删陈旧行但不动外来容器/目录', async () => {
    const orch = makeOrch(makeCfg())
    await orch.createReserve('replaced', adminId, 3)
    await orch.provisionCreate(queue.lastCreate('replaced').name, queue.lastCreate('replaced').configText)
    // 模拟：同名容器被外部重建（新 containerId ≠ row.containerId）
    runtime.containers.set('replaced', {
      containerId: 'foreign-cid',
      name: 'openclaw-gw-replaced',
      running: true,
      status: 'running',
      image: 'other:img',
      port: 19000,
      instanceName: 'replaced',
    })
    await orch.deleteEnqueue('replaced', adminId)
    await orch.provisionDelete(queue.lastDelete('replaced').name)
    // 陈旧行被删（释放 name/port 记账）
    expect(await ctx.prisma.container.findUnique({ where: { name: 'replaced' } })).toBeNull()
    // 外来容器未被 stop/remove
    expect(runtime.stopped).not.toContain('replaced')
    expect(runtime.removed).not.toContain('replaced')
    expect(runtime.containers.has('replaced')).toBe(true)
    // workspace 目录未被 rmtree（外来容器可能正 bind-mount 它）
    expect(existsSync(path.join(dir, 'instances', 'replaced'))).toBe(true)
  })
})
