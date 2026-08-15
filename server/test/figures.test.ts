// T01 —— Authenticated Figure creation（docs/autofigure/tickets/T01-authenticated-figure-creation.md）
// 接缝：REST 信封接缝（setupTestApp + seedUser + login + bearer）+ 事务 seam（createFigureWithJobInTx fake tx）。
// flag 开 = setupTestApp({ figures: {} }) 注入 figures deps；flag 关 = 不注入（路由未装配 → 90005）。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, login, bearer } from './helpers'
import { createFigureWithJobInTx, type FigureCreateTx } from '../src/figures/service'

describe('T01 POST /figures（flag 开，REST 信封接缝）', () => {
  let ctx: TestContext
  let access: string

  beforeAll(async () => {
    ctx = await setupTestApp({ figures: {} }) // flag 开 = figures deps 已装配
    await seedUser(ctx.prisma, 'figuser', 'pw-figuser-secure')
    const lg = await login(ctx.request, 'figuser', 'pw-figuser-secure')
    access = lg.access!
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('AC3+AC8：合法 prompt → HTTP 200 + #312 信封 code 0，data={figureId, jobId, status:"queued"}', async () => {
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .send({ prompt: 'A bar chart of monthly revenue' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      code: 0,
      message: expect.any(String),
      data: { figureId: expect.any(String), jobId: expect.any(String), status: 'queued' },
    })
  })

  it('AC4：数据库恰好 1 Figure + 1 Job；status=queued / errorMessage=null / ownerId=认证用户', async () => {
    const before = await ctx.prisma.figure.count()
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .send({ prompt: 'flowchart of CI pipeline' })
    expect(res.body.code).toBe(0)

    const figureCount = await ctx.prisma.figure.count()
    const jobCount = await ctx.prisma.generationJob.count()
    expect(figureCount).toBe(before + 1)
    expect(jobCount).toBe(figureCount) // 1:1 —— 恰好一个 Job 对应一个 Figure

    const figure = await ctx.prisma.figure.findFirst({
      where: { id: res.body.data.figureId },
    })
    expect(figure).not.toBeNull()
    const me = await ctx.prisma.user.findUnique({ where: { username: 'figuser' } })
    expect(figure!.ownerId).toBe(me!.id) // ownerId 只来自认证身份
    const job = await ctx.prisma.generationJob.findUnique({ where: { figureId: figure!.id } })
    expect(job).not.toBeNull()
    expect(job!.status).toBe('queued')
    expect(job!.errorMessage).toBeNull()
    expect(job!.figureId).toBe(figure!.id)
  })

  it('AC7：客户端随请求提交 userId 被忽略，ownerId 只来自认证身份', async () => {
    const me = await ctx.prisma.user.findUnique({ where: { username: 'figuser' } })
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .send({ prompt: 'venn diagram of skills', userId: 'someone-elses-id' })
    expect(res.body.code).toBe(0)
    const figure = await ctx.prisma.figure.findUnique({ where: { id: res.body.data.figureId } })
    expect(figure!.ownerId).toBe(me!.id)
    expect(figure!.ownerId).not.toBe('someone-elses-id')
  })

  it('AC5：空 prompt → 90002 + 零行落库', async () => {
    const beforeF = await ctx.prisma.figure.count()
    const beforeJ = await ctx.prisma.generationJob.count()
    const res = await ctx.request.post('/api/v1/figures').set(bearer(access)).send({ prompt: '' })
    expect(res.body.code).toBe(90002)
    expect(await ctx.prisma.figure.count()).toBe(beforeF)
    expect(await ctx.prisma.generationJob.count()).toBe(beforeJ)
  })

  it('AC5：纯空白 prompt（trim 后空）→ 90002 + 零行落库', async () => {
    const beforeF = await ctx.prisma.figure.count()
    const res = await ctx.request.post('/api/v1/figures').set(bearer(access)).send({ prompt: '   ' })
    expect(res.body.code).toBe(90002)
    expect(await ctx.prisma.figure.count()).toBe(beforeF)
  })

  it('AC5：超长 prompt（>4000）→ 90002 + 零行落库', async () => {
    const beforeF = await ctx.prisma.figure.count()
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .send({ prompt: 'x'.repeat(4001) })
    expect(res.body.code).toBe(90002)
    expect(await ctx.prisma.figure.count()).toBe(beforeF)
  })

  it('AC5：类型错 prompt（非字符串）→ 90002 + 零行落库', async () => {
    const beforeF = await ctx.prisma.figure.count()
    const res = await ctx.request.post('/api/v1/figures').set(bearer(access)).send({ prompt: 123 })
    expect(res.body.code).toBe(90002)
    expect(await ctx.prisma.figure.count()).toBe(beforeF)
  })

  it('AC6：事务层失败 → 失败信封（90000），无孤儿 Figure、无游离 Job', async () => {
    const beforeF = await ctx.prisma.figure.count()
    const beforeJ = await ctx.prisma.generationJob.count()
    // 模拟 DB 事务层中断：$transaction 整体 reject → 两个 create 均回滚
    const spy = vi.spyOn(ctx.prisma, '$transaction').mockRejectedValueOnce(new Error('simulated tx failure'))
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .send({ prompt: 'sequence diagram of login' })
    spy.mockRestore()
    expect(res.body.code).not.toBe(0) // 失败信封（90000 兜底）
    expect(res.body.data).toBeNull()
    expect(await ctx.prisma.figure.count()).toBe(beforeF)
    expect(await ctx.prisma.generationJob.count()).toBe(beforeJ)
  })

  it('AC6：真事务内 Job 写失败（job 表中止触发器）→ 失败信封 + 真实回滚无孤儿', async () => {
    const beforeF = await ctx.prisma.figure.count()
    const beforeJ = await ctx.prisma.generationJob.count()
    // 上例 mock 整个 $transaction reject——figure.create 从未执行，只测了路由失败面。
    // 本测试在 generation_jobs 上挂 BEFORE INSERT 中止触发器，让「figure 已插入、job 写入
    // 失败」在真实交互式事务内发生：验证 AC6 的「无孤儿 Figure」由 SQLite 事务原子性兑现
    //（figure insert 未提交，job insert abort → 整体 ROLLBACK）。
    const dbPath = ctx.dbUrl.replace(/^file:/, '')
    const sqlite = new Database(dbPath)
    sqlite.exec(
      `CREATE TRIGGER "test_job_insert_abort" BEFORE INSERT ON "generation_jobs"
       BEGIN SELECT RAISE(ABORT, 'simulated job write failure'); END`,
    )
    sqlite.close()
    try {
      const res = await ctx.request
        .post('/api/v1/figures')
        .set(bearer(access))
        .send({ prompt: 'x' })
      expect(res.status).toBe(200)
      expect(res.body.code).not.toBe(0) // 失败信封（90000 兜底）
      expect(res.body.data).toBeNull()
      expect(await ctx.prisma.figure.count()).toBe(beforeF) // 真实回滚：无孤儿 Figure
      expect(await ctx.prisma.generationJob.count()).toBe(beforeJ) // 无游离 Job
    } finally {
      const clean = new Database(dbPath)
      clean.exec('DROP TRIGGER IF EXISTS "test_job_insert_abort"')
      clean.close()
    }
  })
})

describe('T01 POST /figures（flag 关 = figures deps 未装配）', () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestApp() // 不注入 figures → 路由未装配
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('AC1：flag 关 → 既有 notFound 信封 90005（路由未装配）', async () => {
    const res = await ctx.request.post('/api/v1/figures').send({ prompt: 'anything' })
    expect(res.status).toBe(200) // 全局信封：HTTP 恒 200
    expect(res.body.code).toBe(90005)
    expect(res.body.data).toBeNull()
  })
})

describe('T01 认证（flag 开）', () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestApp({ figures: {} })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('AC2：未认证（无 bearer）→ 鉴权错误 10001', async () => {
    const res = await ctx.request.post('/api/v1/figures').send({ prompt: 'anything' })
    expect(res.body.code).toBe(10001)
  })

  it('AC2：坏 token → 鉴权错误 10001（同码，不区分坏 token）', async () => {
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer('not-a-real-token'))
      .send({ prompt: 'anything' })
    expect(res.body.code).toBe(10001)
  })
})

describe('T01 事务 seam（createFigureWithJobInTx 原子性）', () => {
  it('成功：Figure 创建后 1:1 创建 queued Job，返回 {figureId, jobId, status:回读值}', async () => {
    const okTx: FigureCreateTx = {
      figure: { create: async () => ({ id: 'figure-1' }) },
      generationJob: { create: async (args: { data: { figureId: string } }) => {
        expect(args.data.figureId).toBe('figure-1')
        return { id: 'job-1', status: 'queued' } // fake 模拟 DB 行回读（默认 queued）
      } },
    }
    await expect(createFigureWithJobInTx(okTx, { ownerId: 'u1', prompt: 'p' })).resolves.toEqual({
      figureId: 'figure-1',
      jobId: 'job-1',
      status: 'queued',
    })
  })

  it('AC6：第二次写失败（Job 落库 reject）→ seam 抛错，绝不返回成功 queued', async () => {
    const failingTx: FigureCreateTx = {
      figure: { create: async () => ({ id: 'figure-2' }) },
      generationJob: {
        create: async () => {
          throw new Error('simulated job write failure')
        },
      },
    }
    await expect(createFigureWithJobInTx(failingTx, { ownerId: 'u1', prompt: 'p' })).rejects.toThrow(
      'simulated job write failure',
    )
  })
})
