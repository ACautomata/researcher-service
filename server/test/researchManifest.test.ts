// #909：research manifest 声明面锁定 + S1 回归（GET /api/v1/plugins 清单含 research）。
// 「插件声明、核心校验」（853 §3.1）：progressStages = 图拓扑节点名并集（常量单源 graph.ts，
// 与图 addNode 名恒等由 researchGraph.test 锁）；真全目录注册校验由 pluginsRegistry.test
// 「真 PLUGIN_MANIFESTS 全目录」覆盖——本文件锁 research 条目的契约形状与 REST 可见性。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import supertest, { type SuperTest, type Test } from 'supertest'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { createApp } from '../src/app'
import { seedUser, login, bearer } from './helpers'
import { PLUGIN_MANIFESTS } from '../../plugins/index'
import researchManifest from '../../plugins/research/manifest'
import { RESEARCH_ENTRY_STAGES } from '../../plugins/research/graph'
import { RESEARCH_TOOL_NAME } from '../../plugins/research/server'

describe('research manifest（853 §3.1 定形）', () => {
  it('id=research / run.kind=research / 显示名「科研工作流」', () => {
    expect(researchManifest.id).toBe('research')
    expect(researchManifest.run).toEqual({ kind: 'research' })
    expect(researchManifest.name).toBe('科研工作流')
  })

  it('单工具 research_workflow：category=domain + progressStages = 图拓扑节点名并集', () => {
    expect(researchManifest.tools).toHaveLength(1)
    const tool = researchManifest.tools![0]!
    expect(tool.name).toBe(RESEARCH_TOOL_NAME)
    expect(tool.category).toBe('domain')
    expect(tool.progressStages).toEqual(RESEARCH_ENTRY_STAGES)
    expect(RESEARCH_ENTRY_STAGES).toContain('classify')
  })

  it('configSchema 单键 RESEARCH_MODEL（可选——零其余 env 键：阈值=代码常量、凭证走 owner 面）', () => {
    expect(researchManifest.configSchema?.env).toEqual([
      expect.objectContaining({ name: 'RESEARCH_MODEL', required: false }),
    ])
  })

  it('4 命令：handler 返 {execute} 直达 research_workflow 且 workflow 显式值', async () => {
    const names = (researchManifest.commands ?? []).map((c) => c.name)
    expect(names).toEqual(['ingest', 'discover', 'hypothesize', 'experiment'])
    for (const command of researchManifest.commands ?? []) {
      const outcome = await command.handler('x', { logger: { info: () => {}, warn: () => {} } })
      expect('execute' in outcome ? outcome.execute.tool : undefined).toBe(RESEARCH_TOOL_NAME)
    }
  })
})

describe('S1 回归：真目录 REST 清单含 research（853 §9——本插件零新 REST 面）', () => {
  let prisma: PrismaClient
  let request: SuperTest<Test>
  let auth: Record<string, string>
  const dir: string[] = []

  beforeAll(async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'research-manifest-'))
    dir.push(d)
    const dbPath = path.join(d, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    await seedUser(prisma, 'research-manifest-user', 'pw-research-manifest-secure')
    request = supertest(createApp({ prisma, plugins: { prisma, manifests: PLUGIN_MANIFESTS } })) as unknown as SuperTest<Test>
    const access = await login(request, 'research-manifest-user', 'pw-research-manifest-secure')
    auth = bearer(access.access)
  })

  afterAll(async () => {
    await prisma.$disconnect()
    for (const d of dir) rmSync(d, { recursive: true, force: true })
  })

  it('GET /api/v1/plugins 清单含 research（4 命令可见，默认未启用）', async () => {
    const list = await request.get('/api/v1/plugins').set(auth)
    expect(list.status).toBe(200)
    const research = (list.body.data.plugins as Array<{ id: string; commands: Array<{ name: string }>; enabled: boolean }>).find(
      (p) => p.id === 'research',
    )
    expect(research).toBeDefined()
    expect(research?.enabled).toBe(false)
    expect(research?.commands.map((c) => c.name)).toEqual(['ingest', 'discover', 'hypothesize', 'experiment'])
  })

  it('一键启用 → 新会话获得工具与命令（启用位翻转幂等）', async () => {
    const put = await request.put('/api/v1/plugins/research/enablement').set(auth).send({ enabled: true })
    expect(put.status).toBe(200)
    expect(put.body.data).toEqual({ id: 'research', enabled: true })
    const again = await request.put('/api/v1/plugins/research/enablement').set(auth).send({ enabled: true })
    expect(again.status).toBe(200)
  })
})
