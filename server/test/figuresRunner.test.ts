// T03 runner 测试（docs/autofigure/tickets/T03-single-worker-generation-lifecycle.md）。
//
// 测试面：直接驱动 runner 周期/tick 接缝 + 状态转换纯函数 + 原子领取 seam + 终态写入 seam +
// flag 装配门。逐条对应 AC：
//   AC1 fake 成功 → succeeded（startedAt 领取置位 / finishedAt 终态置位）· AC2 fake 失败 →
//   failed（非敏感 errorMessage）· AC3 原子领取恰一个赢家（至多一次）· AC4 concurrency=1（不同
//   queued Job 不重叠）· AC5 非法终态转换拒绝（纯函数 + 终态写入完整性）· AC6 无自动重试 ·
//   AC7 凭证注入 Port 但绝不落盘/不混同/不泄漏 · AC8 flag 关 → 无 pump。
//
// 无 wall-clock 轮询：时间戳两阶段语义用「直接 await 领取 seam」（running + startedAt，finishedAt
// 仍 null）与「完整 tick 成功/失败路径」（finishedAt 置位）分别确定性断言。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import {
  assertLegalTransition,
  claimQueuedJob,
  persistTerminalState,
  assembleAutoFigureRunner,
  createGenerationRunner,
  type GenerationRunner,
} from '../src/figures/runner'
import { FakeAutoFigureGenerationPort } from './figuresFakePort'

// 临时库建表源（与 setup.ts 同源：better-sqlite3 直读 init.sql，不经 prisma CLI）。
const INIT_SQL = readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8')

let prisma: PrismaClient
let seedSeq = 0

beforeEach(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), `figures-runner-${process.pid}-`))
  const dbPath = path.join(dir, 'test.db')
  const sqlite = new Database(dbPath)
  sqlite.exec(INIT_SQL)
  sqlite.close()
  prisma = createPrismaClient(`file:${dbPath}`)
})

afterEach(async () => {
  await prisma.$disconnect()
})

async function createUser(): Promise<string> {
  const u = await prisma.user.create({
    data: { username: `runner-u-${seedSeq++}`, passwordHash: 'x' },
  })
  return u.id
}

// seed 一个 Figure + 其 1:1 queued GenerationJob（对齐 T01 原子创建结果，不经 HTTP）。
async function seedQueuedJob(prompt: string, userId: string): Promise<string> {
  const figure = await prisma.figure.create({
    data: { ownerId: userId, prompt, idempotencyKey: `runner-key-${seedSeq++}` },
  })
  const job = await prisma.generationJob.create({ data: { figureId: figure.id } })
  return job.id
}

function makeRunner(
  fake: FakeAutoFigureGenerationPort,
  opts: { llmKey?: string } = {},
): GenerationRunner {
  return createGenerationRunner({ prisma, port: fake, llmKey: opts.llmKey ?? 'sk-test-secret' })
}

describe('T03 runner（AC1/AC2）fake 结果 → 终态持久化 + 时间戳', () => {
  it('fake 成功 → succeeded；startedAt 领取置位 + finishedAt 终态置位；errorMessage 恒 null', async () => {
    const userId = await createUser()
    const prompt = '画一幅星空下的麦田'
    const jobId = await seedQueuedJob(prompt, userId)
    const fake = new FakeAutoFigureGenerationPort() // 脚本空 → 默认成功
    const runner = makeRunner(fake)

    await runner.tick()

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('succeeded')
    expect(job.startedAt).not.toBeNull()
    expect(job.finishedAt).not.toBeNull()
    expect(job.errorMessage).toBeNull()
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].input).toEqual({ prompt })
  })

  it('fake 失败 → failed；非敏感 errorMessage 落库；时间戳齐全', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('画一座山', userId)
    const fake = new FakeAutoFigureGenerationPort([{ ok: false, errorMessage: 'provider quota exceeded' }])
    const runner = makeRunner(fake)

    await runner.tick()

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('failed')
    expect(job.errorMessage).toBe('provider quota exceeded')
    expect(job.startedAt).not.toBeNull()
    expect(job.finishedAt).not.toBeNull()
  })

  it('Port 抛异常 → 归一 failed（非敏感消息，不暴露内部栈/凭证）', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('prompt', userId)
    const fake = new FakeAutoFigureGenerationPort()
    fake.throwOnGenerate = true
    const runner = makeRunner(fake)

    await runner.tick()

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('failed')
    expect(job.errorMessage).toBe('生成执行异常（内部错误）')
    expect(job.errorMessage).not.toContain('simulated port crash') // 不暴露内部异常细节
    expect(job.errorMessage).not.toContain('sk-test-secret')
  })
})

describe('T03 原子领取（AC3）恰一个赢家、至多一次', () => {
  it('seam：两个并发领取同一 queued Job → 恰一个 count=1；赢家置 running+startedAt，finishedAt 仍 null', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('prompt', userId)

    const results = await Promise.all([
      claimQueuedJob(prisma, jobId),
      claimQueuedJob(prisma, jobId),
    ])

    // 至多一个赢家（SQL 单语句 + SQLite 单 writer 保证判定原子）
    expect(results.filter(Boolean)).toHaveLength(1)
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('running')
    expect(job.startedAt).not.toBeNull() // 领取置位（running 入口）
    expect(job.finishedAt).toBeNull() // 未到终态
  })

  it('runner：并发两次 tick 同一 Job → 只执行一次生成', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('prompt', userId)
    const fake = new FakeAutoFigureGenerationPort()
    const runner = makeRunner(fake)

    await Promise.all([runner.tick(), runner.tick()])

    expect(fake.calls).toHaveLength(1) // 只生成一次
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(
      'succeeded',
    )
  })
})

describe('T03 concurrency=1（AC4）不同 queued Job 不重叠执行', () => {
  it('A 挂起期间第二次 tick 为 no-op；B 不被并发执行，下一周期才串行处理', async () => {
    const userId = await createUser()
    const jobA = await seedQueuedJob('a', userId)
    const jobB = await seedQueuedJob('b', userId)
    const fake = new FakeAutoFigureGenerationPort()
    const runner = makeRunner(fake)
    fake.mode = 'pending'

    const entered = fake.generateEntered() // 先注册「A 已进入 generate」等待点
    const t1 = runner.tick() // A：领取 + 挂起于 generate（active 置位）
    const t2 = runner.tick() // active → no-op（不同 Job 不重叠执行）
    await t2 // t2 未启动任何 runOne

    await entered // 确定性：A 的 generate 已进入（resolver 已就位）
    fake.resolveNext({ ok: true }) // A 成功
    await t1

    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobA } })).status).toBe(
      'succeeded',
    )
    expect(fake.calls).toHaveLength(1) // 至此刻只生成了 A
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobB } })).status).toBe(
      'queued', // B 从未被重叠执行
    )

    fake.mode = 'auto' // A 已完成；B 走正常成功路径（否则 B 也挂起，非本用例意图）
    await runner.tick() // 下一周期才处理 B（串行）
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobB } })).status).toBe(
      'succeeded',
    )
    expect(fake.calls).toHaveLength(2)
  })
})

describe('T03 状态转换完整性（AC5）', () => {
  it('合法转换放行：queued→running、running→succeeded|failed', () => {
    expect(() => assertLegalTransition('queued', 'running')).not.toThrow()
    expect(() => assertLegalTransition('running', 'succeeded')).not.toThrow()
    expect(() => assertLegalTransition('running', 'failed')).not.toThrow()
  })

  it('非法终态转换拒绝：failed→succeeded / failed→running / succeeded→running / succeeded→failed', () => {
    expect(() => assertLegalTransition('failed', 'succeeded')).toThrow(/非法 GenerationJob 状态转换/)
    expect(() => assertLegalTransition('failed', 'running')).toThrow(/非法 GenerationJob 状态转换/)
    expect(() => assertLegalTransition('succeeded', 'running')).toThrow(/非法 GenerationJob 状态转换/)
    expect(() => assertLegalTransition('succeeded', 'failed')).toThrow(/非法 GenerationJob 状态转换/)
  })

  it('终态写入以 status=running 为条件：已终态 Job 再写不生效（不覆盖/不重试）', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('prompt', userId)
    const fake = new FakeAutoFigureGenerationPort()
    const runner = makeRunner(fake)
    await runner.tick() // → succeeded

    // 对已 succeeded 的 Job 再写 failed → 条件不匹配，返回 false，状态不被覆盖
    const overwritten = await persistTerminalState(prisma, jobId, 'failed', 'should-not-stick')
    expect(overwritten).toBe(false)
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('succeeded')
    expect(job.errorMessage).toBeNull()
  })
})

describe('T03 无自动重试（AC6）', () => {
  it('失败 Job 反复 tick 不再执行：generate 调用不增加、状态/消息不变', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('prompt', userId)
    const fake = new FakeAutoFigureGenerationPort([{ ok: false, errorMessage: 'boom' }])
    const runner = makeRunner(fake)

    await runner.tick()
    await runner.tick()
    await runner.tick()

    expect(fake.calls).toHaveLength(1) // 不自动重试
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('failed')
    expect(job.errorMessage).toBe('boom')
  })
})

describe('T03 凭证纪律（AC7）服务端注入、绝不落盘/不混同/不泄漏', () => {
  it('credential 与 input 分离注入；不落盘、不出现在失败消息', async () => {
    const userId = await createUser()
    const prompt = '画一幅星空'
    const key = 'sk-super-secret-xyz'
    const jobId = await seedQueuedJob(prompt, userId)
    const fake = new FakeAutoFigureGenerationPort([{ ok: false, errorMessage: 'quota exceeded' }])
    const runner = makeRunner(fake, { llmKey: key })

    await runner.tick()

    // 分离注入：input 只有 prompt；credential 只有 apiKey（各自独立，不混同）
    expect(fake.calls[0].input).toEqual({ prompt })
    expect(Object.keys(fake.calls[0].input)).toEqual(['prompt'])
    expect(fake.calls[0].credential).toEqual({ apiKey: key })

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('failed')
    expect(job.errorMessage).toBe('quota exceeded') // 非敏感
    expect(job.errorMessage).not.toContain(key)

    // 凭证不落盘：Figure/Job 行任一字段都不含 key
    const figure = await prisma.figure.findUniqueOrThrow({ where: { id: job.figureId } })
    expect(JSON.stringify(job)).not.toContain(key)
    expect(JSON.stringify(figure)).not.toContain(key)
  })
})

describe('T03 flag 装配门（AC8）', () => {
  it('flag 关 → 不构造 pump（null）；queued 恒不迁移', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('prompt', userId)
    const fake = new FakeAutoFigureGenerationPort()

    const handle = assembleAutoFigureRunner({ prisma, port: fake, llmKey: 'k', enabled: false })
    expect(handle).toBeNull() // 无 pump

    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(
      'queued',
    )
  })

  it('flag 开 → 构造并启动 pump；tick 周期处理 queued Job；close 优雅关闭', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('prompt', userId)
    const fake = new FakeAutoFigureGenerationPort()

    const handle = assembleAutoFigureRunner({ prisma, port: fake, llmKey: 'k', enabled: true })
    expect(handle).not.toBeNull()

    await handle!.runner.tick() // 确定性驱动一个周期
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(
      'succeeded',
    )

    await handle!.close() // 停 pump、等在飞周期（interval unref，不挂进程）
  })
})

describe('T03 start/stop 生命周期', () => {
  it('start 幂等（不重复加 timer）；stop 清理 timer', async () => {
    const siSpy = vi.spyOn(globalThis, 'setInterval')
    const ciSpy = vi.spyOn(globalThis, 'clearInterval')
    try {
      const fake = new FakeAutoFigureGenerationPort()
      const runner = makeRunner(fake)
      runner.start()
      runner.start() // 幂等：第二次不再加 timer
      expect(siSpy).toHaveBeenCalledTimes(1)
      await runner.stop()
      expect(ciSpy).toHaveBeenCalledTimes(1)
    } finally {
      siSpy.mockRestore()
      ciSpy.mockRestore()
    }
  })

  it('stop 等待在飞周期 settle（优雅关闭）', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('prompt', userId)
    const fake = new FakeAutoFigureGenerationPort()
    const runner = makeRunner(fake)
    fake.mode = 'pending'

    const entered = fake.generateEntered() // 先注册等待点（避免 resolve 先于 generate 进入）
    const t1 = runner.tick() // 挂起于 generate
    const stopP = runner.stop() // 应等待在飞周期
    await entered // A 的 generate 已进入
    fake.resolveNext({ ok: true })
    await t1
    await stopP // 不挂死 → stop 等待生效

    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(
      'succeeded',
    )
  })
})
