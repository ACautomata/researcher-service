// #788 S1 信封级集成：插件目录/启用位 REST（#752 §4.3 R8 · 8xxxx 码段）。
// 验收面：目录渲染 + per-user 启用位；PUT 幂等 upsert；80040 目录外 id 同码防探测；
// 90002 body 校验；认证边界。
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

const fixtureCatalog: PluginManifest[] = [
  definePlugin({ id: 'autofigure', name: 'AutoFigure', description: 'method figure generation', version: '1.0.0' }),
  definePlugin({ id: 'second', name: 'Second', description: 'another plugin', version: '0.2.0' }),
]

describe('#788 plugins REST（S1，#752 §4.3）', () => {
  let prisma: PrismaClient
  let request: SuperTest<Test>
  let auth: Record<string, string>
  let otherAuth: Record<string, string>
  const dir: string[] = []

  beforeAll(async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'plugins-api-'))
    dir.push(d)
    const dbPath = path.join(d, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    await seedUser(prisma, 'plugins-api-user', 'pw-plugins-api-secure')
    await seedUser(prisma, 'plugins-api-other', 'pw-plugins-api-other')
    request = supertest(createApp({ prisma, plugins: { prisma, manifests: fixtureCatalog } })) as unknown as SuperTest<Test>
    const access = await login(request, 'plugins-api-user', 'pw-plugins-api-secure')
    const otherAccess = await login(request, 'plugins-api-other', 'pw-plugins-api-other')
    auth = bearer(access.access)
    otherAuth = bearer(otherAccess.access)
  })

  afterAll(async () => {
    await prisma.$disconnect()
    for (const d of dir) rmSync(d, { recursive: true, force: true })
  })

  it('目录清单带 per-user 启用位（无行 = 默认未启用）', async () => {
    const res = await request.get('/api/v1/plugins').set(auth)
    expect(res.body.code).toBe(0)
    expect(res.body.data.plugins).toEqual([
      { id: 'autofigure', name: 'AutoFigure', description: 'method figure generation', version: '1.0.0', enabled: false },
      { id: 'second', name: 'Second', description: 'another plugin', version: '0.2.0', enabled: false },
    ])
  })

  it('PUT 启用后 GET 反映启用位；重复 PUT 幂等', async () => {
    const put = await request.put('/api/v1/plugins/autofigure/enablement').set(auth).send({ enabled: true })
    expect(put.body.code).toBe(0)
    expect(put.body.data).toEqual({ id: 'autofigure', enabled: true })
    const again = await request.put('/api/v1/plugins/autofigure/enablement').set(auth).send({ enabled: true })
    expect(again.body.code).toBe(0)
    const list = await request.get('/api/v1/plugins').set(auth)
    expect(list.body.data.plugins).toEqual([expect.objectContaining({ id: 'autofigure', enabled: true }), expect.objectContaining({ id: 'second', enabled: false })])
  })

  it('禁用 = enabled:false 行为对称（非删除行）', async () => {
    const put = await request.put('/api/v1/plugins/second/enablement').set(auth).send({ enabled: true })
    expect(put.body.code).toBe(0)
    const disable = await request.put('/api/v1/plugins/second/enablement').set(auth).send({ enabled: false })
    expect(disable.body.code).toBe(0)
    expect(disable.body.data).toEqual({ id: 'second', enabled: false })
    const list = await request.get('/api/v1/plugins').set(auth)
    expect(list.body.data.plugins).toEqual([expect.objectContaining({ id: 'autofigure', enabled: true }), expect.objectContaining({ id: 'second', enabled: false })])
  })

  it('目录外 id → 80040（同码防探测），不落任何行', async () => {
    const res = await request.put('/api/v1/plugins/no-such-plugin/enablement').set(auth).send({ enabled: true })
    expect(res.body.code).toBe(80040)
    expect(res.body.data).toBeNull()
  })

  it('启用位 per-user 隔离：其他用户不受影响', async () => {
    const list = await request.get('/api/v1/plugins').set(otherAuth)
    expect(list.body.data.plugins).toEqual([expect.objectContaining({ id: 'autofigure', enabled: false }), expect.objectContaining({ id: 'second', enabled: false })])
  })

  it('body 校验：enabled 缺失/非布尔 → 90002', async () => {
    const missing = await request.put('/api/v1/plugins/autofigure/enablement').set(auth).send({})
    expect(missing.body.code).toBe(90002)
    const wrong = await request.put('/api/v1/plugins/autofigure/enablement').set(auth).send({ enabled: 'yes' })
    expect(wrong.body.code).toBe(90002)
  })

  it('认证边界：无 token → 10001', async () => {
    const res = await request.get('/api/v1/plugins')
    expect(res.body.code).toBe(10001)
  })
})
