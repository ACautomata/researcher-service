// createFigure 单写方法（#791 · #744 §5.1/§11.1）——S2 纯逻辑（fake delegate）+ S1 落库验证。
// 覆盖：全字段落库（svg/png/meta 序列化/sessionId 溯源）/ png 缺省 / sessionId null / 经 REST
// 装配面读回一致（产物经 /svg /png 读路径可见——单写与读面闭环）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, login, bearer } from './helpers'
import { createFigure } from '../src/figures/service'

const META = {
  v: 1,
  noIconMode: false,
  placeholderMode: 'label',
  fixAttempts: 0,
  optimizeIterations: 2,
  imageGenModel: 'test-image-model',
  svgModel: 'test-svg-model',
  renderer: 'sharp-librsvg',
  previewReady: true,
}

describe('createFigure（S2 纯逻辑 + S1 落库）', () => {
  let ctx: TestContext
  let user: { id: string }
  let access: string

  beforeAll(async () => {
    ctx = await setupTestApp({})
    user = await seedUser(ctx.prisma, 'cf-user', 'pw-cfuser-secure')
    access = (await login(ctx.request, 'cf-user', 'pw-cfuser-secure')).access!
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('全字段落库：svg/png 字节/meta JSON 序列化/sessionId 溯源', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    const { figureId } = await createFigure(ctx.prisma, {
      ownerId: user.id,
      prompt: 'a flowchart of the pipeline',
      svg: '<svg id="final"></svg>',
      pngBytes: png,
      meta: META,
      sessionId: 'sess-1',
    })
    const row = await ctx.prisma.figure.findUniqueOrThrow({ where: { id: figureId } })
    expect(row.ownerId).toBe(user.id)
    expect(row.prompt).toBe('a flowchart of the pipeline')
    expect(row.svg).toBe('<svg id="final"></svg>')
    expect(Buffer.from(row.png as unknown as Uint8Array)).toEqual(Buffer.from(png))
    expect(JSON.parse(row.evaluation ?? '')).toEqual(META)
    expect(row.sessionId).toBe('sess-1')
  })

  it('png 缺省 + sessionId 缺省 → null 列（渲染失败不致命语义）', async () => {
    const { figureId } = await createFigure(ctx.prisma, {
      ownerId: user.id,
      prompt: 'no-preview',
      svg: '<svg/>',
      meta: { ...META, previewReady: false },
    })
    const row = await ctx.prisma.figure.findUniqueOrThrow({ where: { id: figureId } })
    expect(row.png).toBeNull()
    expect(row.sessionId).toBeNull()
  })

  it('产物经读面闭环可见（单写 → /svg /png /detail 投影一致）', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9])
    const { figureId } = await createFigure(ctx.prisma, {
      ownerId: user.id,
      prompt: 'closed loop',
      svg: '<svg id="loop"></svg>',
      pngBytes: png,
      meta: META,
      sessionId: 'sess-2',
    })
    const detail = await ctx.request.get(`/api/v1/figures/${figureId}`).set(bearer(access))
    expect(detail.body.data).toMatchObject({ figureId, prompt: 'closed loop', sessionId: 'sess-2', previewReady: true })
    const svg = await ctx.request.get(`/api/v1/figures/${figureId}/svg`).set(bearer(access))
    expect(Buffer.from(svg.body).toString('utf8')).toBe('<svg id="loop"></svg>')
    const pngRes = await ctx.request.get(`/api/v1/figures/${figureId}/png`).set(bearer(access))
    expect(Buffer.from(pngRes.body)).toEqual(Buffer.from(png))
  })
})
