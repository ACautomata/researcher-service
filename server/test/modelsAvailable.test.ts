// GET /models/available 信封级集成（#978 · ADR 0019 接口面）：会话模型覆盖取值域 =
// 本人 BYOK 端点（createdAt asc）+ 平台虚拟条目垫底；capability 三值与 effortNote 由
// presets 能力表单源派生（ADR 0020 per-model 映射表）——前端零映射表副本的供给面契约。
//
// 验收口径（#978）：六预设能力逐条断言（kimi=none、minimax/glm=thinking-only、
// deepseek/anthropic/openai=native）、BYOK 无元数据模型默认 native + modelKwargs 注记、
// 无 key 材料、未知预设行 fail-closed 跳过、ownerId 归属门。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import supertest, { type SuperTest, type Test } from 'supertest'
import { createPrismaClient } from '../src/prisma'
import { createApp } from '../src/app'
import type { PrismaClient } from '../src/generated/prisma/client'
import { seedUser, login, bearer } from './helpers'
import { CODE } from '../src/codes'

interface AvailableRow {
  providerId: string
  modelId: string
  name: string
  capability: 'native' | 'thinking-only' | 'none'
  effortNote: string
}

// 六预设 BYOK 行种子（providerId = preset id 便于断言；非平台预设须自带 key——写侧既有门）。
const SEEDED_PROVIDERS: Array<{ providerId: string; presetId: string; models: Array<Record<string, unknown>> }> = [
  { providerId: 'minimax', presetId: 'minimax', models: [{ id: 'MiniMax-M3', name: 'MiniMax M3' }] },
  { providerId: 'anthropic', presetId: 'anthropic', models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }] },
  { providerId: 'openai', presetId: 'openai', models: [{ id: 'gpt-5.1', name: 'GPT-5.1' }] },
  { providerId: 'deepseek', presetId: 'deepseek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] },
  { providerId: 'kimi', presetId: 'kimi', models: [{ id: 'kimi-k2', name: 'Kimi K2' }] },
  { providerId: 'zhipu', presetId: 'zhipu', models: [{ id: 'glm-4.6', name: 'GLM-4.6' }] },
]

describe('GET /models/available（#978）', () => {
  let prisma: PrismaClient
  let request: SuperTest<Test>
  let access: string
  let otherAccess: string

  beforeAll(async () => {
    const dir = mkdtempSync(`${tmpdir()}/models-available-`)
    const dbPath = `${dir}/test.db`
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)

    const user = await seedUser(prisma, 'avail-user1', 'pw-avail1-secure')
    const other = await seedUser(prisma, 'avail-user2', 'pw-avail2-secure')
    for (const p of SEEDED_PROVIDERS) {
      await prisma.modelProvider.create({
        data: {
          ownerId: user.id,
          providerId: p.providerId,
          presetId: p.presetId,
          credentialCipher: null, // 平台预设共享 key 面；available 不读凭证，NULL 即可
          modelsJson: JSON.stringify(p.models),
        },
      })
    }
    // BYOK 第三方自定义模型（无逐模型元数据 → 缺省 native + modelKwargs 注记）
    await prisma.modelProvider.create({
      data: {
        ownerId: user.id,
        providerId: 'my-relay',
        presetId: 'openai',
        modelsJson: JSON.stringify([{ id: 'proxy-llm-7b', name: '中转 7B' }]),
      },
    })
    // 未知预设行（清单随版收缩形态）：fail-closed 跳过，不进可选域
    await prisma.modelProvider.create({
      data: {
        ownerId: user.id,
        providerId: 'ghost',
        presetId: 'no-such-preset',
        modelsJson: JSON.stringify([{ id: 'ghost-model' }]),
      },
    })
    // 他人端点：归属门隔离面
    await prisma.modelProvider.create({
      data: {
        ownerId: other.id,
        providerId: 'theirs',
        presetId: 'kimi',
        modelsJson: JSON.stringify([{ id: 'kimi-k2' }]),
      },
    })

    const app = createApp({ prisma })
    request = supertest(app) as unknown as SuperTest<Test>
    access = (await login(request, 'avail-user1', 'pw-avail1-secure')).access!
    otherAccess = (await login(request, 'avail-user2', 'pw-avail2-secure')).access!
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('六预设模型 capability 三值与 effortNote 逐条（presets 能力表单源）', async () => {
    const res = await request.get('/api/v1/models/available').set(bearer(access))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(CODE.OK)
    const rows = res.body.data as AvailableRow[]
    const byModel = new Map(rows.map((r) => [r.modelId, r]))
    expect(byModel.get('kimi-k2')).toMatchObject({ capability: 'none', effortNote: '该模型无推理强度通道', name: 'Kimi K2' })
    expect(byModel.get('MiniMax-M3')).toMatchObject({ capability: 'thinking-only', effortNote: '标准 · 深思＝开（简洁＝思考关）' })
    expect(byModel.get('glm-4.6')).toMatchObject({ capability: 'thinking-only', effortNote: '标准 · 深思＝开（简洁＝思考关）' })
    expect(byModel.get('deepseek-v4-flash')).toMatchObject({ capability: 'native', effortNote: '三档 1:1 直传' })
    expect(byModel.get('claude-sonnet-5-5')).toMatchObject({ capability: 'native', effortNote: '三档就近映射 Anthropic effort 五档' })
    expect(byModel.get('gpt-5.1')).toMatchObject({ capability: 'native', effortNote: '三档就近映射 OpenAI reasoning effort 七值' })
  })

  it('BYOK 自定义模型默认 native + modelKwargs 注记；行五键无 key 材料', async () => {
    const res = await request.get('/api/v1/models/available').set(bearer(access))
    const rows = res.body.data as AvailableRow[]
    expect(rows.find((r) => r.modelId === 'proxy-llm-7b')).toEqual({
      providerId: 'my-relay',
      modelId: 'proxy-llm-7b',
      name: '中转 7B',
      capability: 'native',
      effortNote: '经 modelKwargs 注入（第三方兼容面）',
    })
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['capability', 'effortNote', 'modelId', 'name', 'providerId'])
    }
  })

  it('平台虚拟条目垫底（providerId=platform，末位）；未知预设行跳过；他人端点不可见', async () => {
    const res = await request.get('/api/v1/models/available').set(bearer(access))
    const rows = res.body.data as AvailableRow[]
    expect(rows.at(-1)!.providerId).toBe('platform')
    expect(rows.filter((r) => r.providerId === 'platform').length).toBeGreaterThanOrEqual(1)
    expect(rows.some((r) => r.providerId === 'ghost' || r.modelId === 'ghost-model')).toBe(false)
    expect(rows.some((r) => r.providerId === 'theirs')).toBe(false)
    // 平台条目模型 = platformModels（LLM_MODEL 缺省 → 平台预设 defaultModels）——不在本测试
    // 钉具体预设（env 可变），只钉其模型行形状与其他行同构。
    for (const row of rows.filter((r) => r.providerId === 'platform')) {
      expect(typeof row.modelId).toBe('string')
      expect(['native', 'thinking-only', 'none']).toContain(row.capability)
    }
  })

  it('ownerId 归属门：他人视角只见自己的端点 + 平台条目', async () => {
    const res = await request.get('/api/v1/models/available').set(bearer(otherAccess))
    const rows = res.body.data as AvailableRow[]
    expect(rows.map((r) => r.providerId)).toEqual(['theirs', 'platform'])
  })
})
