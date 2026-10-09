// 插件 LLM 指派 REST（#883 T3 · /api/v1/plugins/llm-assignments 面）。
// 验收面（issue AC）：targets = 声明 llm 的插件 ∪ 保留键 'judge'；未声明插件指派写侧拒
//（80040 同码防探测）；端点 ∈ 用户端点集 ∪ 'platform'（90002 字段级）；模型须属该端点
// 模型集；指派变更事务内 bump 配置版本（热生效信号）；per-user 隔离。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import supertest, { type SuperTest, type Test } from 'supertest'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { createApp } from '../src/app'
import { definePlugin, type PluginManifest } from '../src/plugins/api'
import { seedUser, login, bearer } from './helpers'
import { config } from '../src/config'

// 测试目录：autofigure 带 llm 声明；plain 无声明（指派写侧拒的反例）。
const fixtureCatalog: PluginManifest[] = [
  definePlugin({
    id: 'autofigure', name: 'AutoFigure', description: 'method figure generation', version: '1.0.0',
    llm: { description: 'SVG 模板多模态生成', defaultModel: 'MiniMax-M3' },
  }),
  definePlugin({ id: 'plain', name: 'Plain', description: 'no llm declaration', version: '1.0.0' }),
]

const BASE = '/api/v1/plugins'
const platformModel = config.llm.model !== '' ? config.llm.model : 'MiniMax-M3' // 缺省预设 minimax 首模型

describe('#883 插件 LLM 指派 REST（T3）', () => {
  let prisma: PrismaClient
  let request: SuperTest<Test>
  let auth: Record<string, string>
  let otherAuth: Record<string, string>
  let ownerId: string
  const dir: string[] = []
  const configVersion = async (): Promise<number> =>
    (await prisma.configMeta.findUnique({ where: { id: 1 } }))?.version ?? 1

  beforeAll(async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'plugin-assign-'))
    dir.push(d)
    const dbPath = path.join(d, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma, 'assign-user', 'pw-assign1-secure')
    await seedUser(prisma, 'assign-other', 'pw-assign2-secure')
    ownerId = user.id
    await prisma.modelProvider.create({ data: {
      ownerId: user.id, providerId: 'my-gpt', presetId: 'openai',
      modelsJson: JSON.stringify([{ id: 'gpt-5.1' }, { id: 'gpt-mini' }]),
    } })
    request = supertest(createApp({ prisma, plugins: { prisma, manifests: fixtureCatalog } })) as unknown as SuperTest<Test>
    auth = bearer((await login(request, 'assign-user', 'pw-assign1-secure')).access!)
    otherAuth = bearer((await login(request, 'assign-other', 'pw-assign2-secure')).access!)
  })
  afterAll(async () => {
    await prisma.$disconnect()
    for (const d of dir) rmSync(d, { recursive: true, force: true })
  })

  it('未认证 → 10001（三端点同守）', async () => {
    for (const p of [`${BASE}/llm-assignments`, `${BASE}/autofigure/llm-assignment`]) {
      const res = await request.get(p)
      expect(res.body.code).toBe(10001)
    }
    const put = await request.put(`${BASE}/autofigure/llm-assignment`).send({ provider_id: null, model_id: null })
    expect(put.body.code).toBe(10001)
  })

  it('GET：targets = llm 声明插件 ∪ judge；assignments 初始为空', async () => {
    const res = await request.get(`${BASE}/llm-assignments`).set(auth)
    expect(res.body.code).toBe(0)
    expect(res.body.data.targets).toEqual([
      { plugin_id: 'autofigure', description: 'SVG 模板多模态生成', default_model: 'MiniMax-M3' },
      { plugin_id: 'judge', description: expect.any(String) },
    ])
    expect(res.body.data.assignments).toEqual([])
  })

  it('PUT BYOK 端点+模型：upsert 落行 + 事务内 bump 配置版本', async () => {
    const before = await configVersion()
    const res = await request.put(`${BASE}/autofigure/llm-assignment`).set(auth)
      .send({ provider_id: 'my-gpt', model_id: 'gpt-mini' })
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ plugin_id: 'autofigure', provider_id: 'my-gpt', model_id: 'gpt-mini', updated_at: expect.any(String) })
    expect(await configVersion()).toBe(before + 1)
    const row = await prisma.pluginLlmAssignment.findUnique({
      where: { ownerId_pluginId: { ownerId, pluginId: 'autofigure' } },
    })
    expect(row).toMatchObject({ providerId: 'my-gpt', modelId: 'gpt-mini' })
  })

  it("PUT 'platform' 合法（可省 model_id = 平台默认模型）；重复 PUT 幂等覆盖", async () => {
    const res = await request.put(`${BASE}/autofigure/llm-assignment`).set(auth)
      .send({ provider_id: 'platform' })
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ plugin_id: 'autofigure', provider_id: 'platform', model_id: null, updated_at: expect.any(String) })
    const again = await request.put(`${BASE}/autofigure/llm-assignment`).set(auth)
      .send({ provider_id: 'platform', model_id: platformModel })
    expect(again.body.code).toBe(0)
    expect(again.body.data).toEqual({ plugin_id: 'autofigure', provider_id: 'platform', model_id: platformModel, updated_at: expect.any(String) })
  })

  it("PUT provider_id null = 显式跟随默认链（行保留、字段全空）", async () => {
    const res = await request.put(`${BASE}/autofigure/llm-assignment`).set(auth)
      .send({ provider_id: null, model_id: null })
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ plugin_id: 'autofigure', provider_id: null, model_id: null, updated_at: expect.any(String) })
  })

  it("PUT judge 键行接受（执行面归后票）", async () => {
    const res = await request.put(`${BASE}/judge/llm-assignment`).set(auth)
      .send({ provider_id: 'my-gpt', model_id: 'gpt-5.1' })
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ plugin_id: 'judge', provider_id: 'my-gpt', model_id: 'gpt-5.1', updated_at: expect.any(String) })
  })

  it('未声明 llm 的插件指派 → 80040（目录外同码防探测）', async () => {
    const res = await request.put(`${BASE}/plain/llm-assignment`).set(auth)
      .send({ provider_id: 'my-gpt', model_id: 'gpt-5.1' })
    expect(res.body.code).toBe(80040)
    const ghost = await request.put(`${BASE}/no-such-plugin/llm-assignment`).set(auth)
      .send({ provider_id: 'my-gpt', model_id: 'gpt-5.1' })
    expect(ghost.body.code).toBe(80040)
  })

  it('端点校验：未知端点 / 保留 id 外形态 / model 无端点 → 90002 字段级', async () => {
    const unknown = await request.put(`${BASE}/autofigure/llm-assignment`).set(auth)
      .send({ provider_id: 'no-such-ep', model_id: 'm' })
    expect(unknown.body.code).toBe(90002)
    expect(JSON.stringify(unknown.body.data ?? unknown.body)).toContain('provider_id')
    const modelNoProvider = await request.put(`${BASE}/autofigure/llm-assignment`).set(auth)
      .send({ provider_id: null, model_id: 'gpt-5.1' })
    expect(modelNoProvider.body.code).toBe(90002)
  })

  it('模型须属该端点模型集：BYOK 集外 / 平台集外 → 90002', async () => {
    const badByok = await request.put(`${BASE}/autofigure/llm-assignment`).set(auth)
      .send({ provider_id: 'my-gpt', model_id: 'not-in-set' })
    expect(badByok.body.code).toBe(90002)
    const badPlatform = await request.put(`${BASE}/autofigure/llm-assignment`).set(auth)
      .send({ provider_id: 'platform', model_id: 'not-in-set' })
    expect(badPlatform.body.code).toBe(90002)
  })

  it('DELETE：撤指派回默认链（删行 + bump）；无行 DELETE 幂等不 bump', async () => {
    await request.put(`${BASE}/judge/llm-assignment`).set(auth).send({ provider_id: 'my-gpt', model_id: 'gpt-5.1' })
    const before = await configVersion()
    const res = await request.delete(`${BASE}/judge/llm-assignment`).set(auth)
    expect(res.body.code).toBe(0)
    expect(await configVersion()).toBe(before + 1)
    expect(await prisma.pluginLlmAssignment.findUnique({ where: { ownerId_pluginId: { ownerId, pluginId: 'judge' } } })).toBeNull()
    const again = await request.delete(`${BASE}/judge/llm-assignment`).set(auth)
    expect(again.body.code).toBe(0)
    expect(await configVersion()).toBe(before + 1)
  })

  it('per-user 隔离：他人端点不可指派；列表只见本人行', async () => {
    const res = await request.put(`${BASE}/autofigure/llm-assignment`).set(otherAuth)
      .send({ provider_id: 'my-gpt', model_id: 'gpt-5.1' })
    expect(res.body.code).toBe(90002)
    const list = await request.get(`${BASE}/llm-assignments`).set(otherAuth)
    expect(list.body.data.assignments).toEqual([])
  })

  it('GET 反映全部行（含显式跟随默认链行）', async () => {
    const list = await request.get(`${BASE}/llm-assignments`).set(auth)
    const autofigure = list.body.data.assignments.find((a: { plugin_id: string }) => a.plugin_id === 'autofigure')
    expect(autofigure).toEqual({ plugin_id: 'autofigure', provider_id: null, model_id: null, updated_at: expect.any(String) })
  })
})
