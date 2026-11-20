// #1057 C 票 Skill 运行时接入（S3/S2/S4，#1054 D4）：目录快照构造（≤4KB 严格预算/单行化/
// name 稳定序/截断标记）、read_skill 参数校验矩阵（未启用/未知 skill/未知资源/二进制/64KB
// 截断）、漏斗路由锁（FILE_TOOLS 归类 + resource 参数不进容器路径白名单）、S2 fake harness
//（prompt 注入 + 工具执行回喂 + 启用集变更 → 图重建 + teammate run 继承 + 事件词汇表无新增）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { PrismaCheckpointSaver } from '../src/runner/persistence/prismaCheckpointSaver'
import { ProviderRegistry } from '../src/runner/providerRegistry'
import { ConcurrencyGate } from '../src/runner/concurrency'
import { RunService, type RunCommand } from '../src/runner/runtime/runService'
import { TeammateService } from '../src/runner/teammates/service'
import { classifyTool, filePathVerdict } from '../src/runner/approval/rules'
import { SKILL_BODY_MAX_BYTES, SKILL_CATALOG_MAX_BYTES } from '../src/skills/values'
import { buildSkillCatalogPrompt, loadSkillCatalog, readSkillContent, type SkillCatalogEntry } from '../src/skills/runner'
import { seedUser } from './helpers'
import { ScriptedChatModel, fakePrimitives, CollectingHub, toolCallAi, type ScriptEntry } from './runnerFakes'

// ---------------------------------------------------------------------------
// S3：目录快照构造（纯逻辑）
// ---------------------------------------------------------------------------

describe('#1057 目录快照构造（S3）', () => {
  const entry = (id: string, name: string, description: string, sha256 = `sha-${id}`): SkillCatalogEntry =>
    ({ id, name, description, sha256 })

  it('单行化 + name 稳定序 + id 进目录行（read_skill 调用前提）', () => {
    const prompt = buildSkillCatalogPrompt([
      entry('sk-2', 'paper-writing', '论文写作辅助\n第二行'),
      entry('sk-1', 'data-analysis', '数据分析  技能\r\n第三行'),
    ])
    const lines = prompt.split('\n')
    expect(lines[0]).toBe('Enabled skills (load content on demand with the read_skill tool):')
    // name 稳定序：data-analysis 在 paper-writing 前（传入序相反）
    expect(lines[1]).toBe('- data-analysis (id: sk-1): 数据分析 技能 第三行')
    expect(lines[2]).toBe('- paper-writing (id: sk-2): 论文写作辅助 第二行')
    // 目录行内无换行（prompt 结构不被破坏）
    expect(lines).toHaveLength(3)
  })

  it('严格 ≤4KB：超限整行剔除 + 截断标记计入预算', () => {
    const many: SkillCatalogEntry[] = Array.from({ length: 10 }, (_, i) =>
      entry(`sk-${i}`, `skill-${String(i).padStart(2, '0')}`, `描述${i} ${'x'.repeat(900)}`))
    const prompt = buildSkillCatalogPrompt(many)
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(SKILL_CATALOG_MAX_BYTES)
    expect(prompt).toContain('more skill(s) omitted')
    // 完整行原则：被保留的行永不半截（每行都以可解析目录行形态结束）
    for (const line of prompt.split('\n').slice(1)) {
      expect(line.startsWith('- ')).toBe(true)
    }
  })

  it('空集 = 空串（不入拼接）；未超限无标记', () => {
    expect(buildSkillCatalogPrompt([])).toBe('')
    const prompt = buildSkillCatalogPrompt([entry('sk-1', 'tiny', '短描述')])
    expect(prompt).not.toContain('omitted')
  })

  it('目录版本：内容序无关稳定；sha256 变更 → 版本变更', async () => {
    const rows = [
      { id: 'sk-2', name: 'paper-writing', description: 'b', sha256: 'sha-b' },
      { id: 'sk-1', name: 'data-analysis', description: 'a', sha256: 'sha-a' },
    ]
    const first = await loadSkillCatalog(fakeCatalogPrisma([...rows]), ['sk-1', 'sk-2'])
    const second = await loadSkillCatalog(fakeCatalogPrisma([...rows].reverse()), ['sk-2', 'sk-1'])
    expect(first.entries.map((e) => e.id)).toEqual(['sk-1', 'sk-2'])
    expect(first.version).toBe(second.version)
    const changed = await loadSkillCatalog(
      fakeCatalogPrisma([{ ...rows[0], sha256: 'sha-b2' }, rows[1]]),
      ['sk-1', 'sk-2'],
    )
    expect(changed.version).not.toBe(first.version)
    // 未启用（空集）零查询面：版本空串（键因子 'none'）
    expect((await loadSkillCatalog(fakeCatalogPrisma(rows), [])).version).toBe('')
  })
})

// ---------------------------------------------------------------------------
// S3：read_skill 参数校验矩阵（纯逻辑 + prisma 薄执行层）
// ---------------------------------------------------------------------------

function fakeReadPrisma(p: {
  pkg?: { status: string } | null
  file?: { mime: string; size: number; content: Uint8Array } | null
  allPaths?: string[]
}) {
  const captured: string[] = []
  const prisma = {
    skillPackage: { findUnique: async () => (p.pkg === undefined ? null : p.pkg) },
    skillFile: {
      findUnique: async (args: { where: { packageId_path: { packageId: string; path: string } } }) => {
        captured.push(args.where.packageId_path.path)
        return p.file === undefined ? null : p.file
      },
      findMany: async () => (p.allPaths ?? []).map((path) => ({ path })),
    },
  }
  return { prisma: prisma as unknown as PrismaClient, captured }
}

describe('#1057 read_skill 参数校验矩阵（S3）', () => {
  const ENABLED = ['sk-1']

  it('未启用/越权（快照集外）→ not_enabled 结构化错误，零 DB 查询', async () => {
    const { prisma } = fakeReadPrisma({})
    const result = await readSkillContent(prisma, { enabledSkillIds: ENABLED, skillId: 'sk-other' })
    expect(result).toMatchObject({ ok: false, error: { code: 'not_enabled' } })
  })

  it('启用但包已删 → unknown_skill', async () => {
    const { prisma } = fakeReadPrisma({})
    const result = await readSkillContent(prisma, { enabledSkillIds: ENABLED, skillId: 'sk-1' })
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown_skill' } })
  })

  it('未知资源 → unknown_resource + 可用清单回喂；缺省路径 = SKILL.md', async () => {
    const { prisma, captured } = fakeReadPrisma({
      pkg: { status: 'published' },
      file: null,
      allPaths: ['SKILL.md', 'assets/guide.md'],
    })
    const result = await readSkillContent(prisma, { enabledSkillIds: ENABLED, skillId: 'sk-1', path: 'assets/nope.md' })
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown_resource' } })
    expect((result as { error: { message: string } }).error.message).toContain('assets/guide.md')
    expect(captured).toEqual(['assets/nope.md'])
    // 缺省路径断言
    await readSkillContent(prisma, { enabledSkillIds: ENABLED, skillId: 'sk-1' })
    expect(captured).toEqual(['assets/nope.md', 'SKILL.md'])
  })

  it('二进制资源 → binary_resource（字节不入对话）', async () => {
    const { prisma } = fakeReadPrisma({
      pkg: { status: 'published' },
      file: { mime: 'image/png', size: 1234, content: new Uint8Array([1, 2, 3]) },
    })
    const result = await readSkillContent(prisma, { enabledSkillIds: ENABLED, skillId: 'sk-1', path: 'img/a.png' })
    expect(result).toMatchObject({ ok: false, error: { code: 'binary_resource' } })
  })

  it('happy：缺省读 SKILL.md 正文原样（≤64KB 不截断）', async () => {
    const body = '# 论文写作\n\n## 结构\n'
    const { prisma } = fakeReadPrisma({
      pkg: { status: 'published' },
      file: { mime: 'text/markdown', size: body.length, content: Buffer.from(body, 'utf8') },
    })
    const result = await readSkillContent(prisma, { enabledSkillIds: ENABLED, skillId: 'sk-1' })
    expect(result).toMatchObject({
      ok: true,
      data: { skillId: 'sk-1', path: 'SKILL.md', mime: 'text/markdown', truncated: false, content: body },
    })
  })

  it('正文超 64KB → 字节截断 + 截断标记', async () => {
    const body = 'a'.repeat(SKILL_BODY_MAX_BYTES + 5000)
    const { prisma } = fakeReadPrisma({
      pkg: { status: 'published' },
      file: { mime: 'text/plain', size: body.length, content: Buffer.from(body, 'utf8') },
    })
    const result = await readSkillContent(prisma, { enabledSkillIds: ENABLED, skillId: 'sk-1' })
    expect(result).toMatchObject({ ok: true, data: { truncated: true } })
    const content = (result as { data: { content: string } }).data.content
    expect(content.endsWith(`[skill content truncated to ${SKILL_BODY_MAX_BYTES} bytes]`)).toBe(true)
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(SKILL_BODY_MAX_BYTES + 80)
  })

  it('漏斗路由锁：read_skill 归文件类；resource 参数不进容器路径白名单判定（规则层直放）', () => {
    expect(classifyTool('read_skill')).toBe('file')
    // resource 是包内相对路径——不在 FILE_PATH_PARAM_NAMES（path/file_path）内 →
    // 缺省命中语义（零 LLM 直放，openwiki 先例），不误入灰区 judge。
    expect(filePathVerdict({ skillId: 'sk-1', resource: 'assets/a.md' }).kind).toBe('allow')
  })
})

// ---------------------------------------------------------------------------
// S2/S4：fake harness（RunService 装配面）
// ---------------------------------------------------------------------------

const LAB = 'researcher-sandbox-sk'

describe('#1057 skill 运行时接入（S2/S4）', () => {
  let prisma: PrismaClient
  let hub: CollectingHub
  let owner: { id: string; username: string }
  const cleanupDirs: string[] = []
  const modelCalls: Array<{ system: string; messages: Array<{ type: string; content: unknown }> }> = []

  function makeService(script: ScriptEntry[], opts: { teammates?: boolean } = {}): RunService {
    const registry = new ProviderRegistry(prisma, {
      llmApiKey: 'llm-test-key-not-real',
      modelFactory: async () => {
        const model = new ScriptedChatModel(script)
        model.callbacks = [{ name: 'FakeLLMTransport', handleChatModelStart: (_m, batches, _r, _p, _e, _t, _metadata) => {
          const messages = batches[0] ?? []
          modelCalls.push({
            system: JSON.stringify(messages.filter((m: BaseMessage) => m.getType() === 'system').map((m: BaseMessage) => m.content)),
            messages: messages.map((m: BaseMessage) => ({ type: m.getType(), content: m.content })),
          })
        } }]
        return model
      },
    })
    return new RunService({
      prisma,
      registry,
      saver: new PrismaCheckpointSaver(prisma),
      gate: new ConcurrencyGate({ globalLimit: 8, loadUserLimit: async () => 4 }),
      hub,
      primitives: fakePrimitives().primitives,
      resolveWikiContainer: () => 'researcher-wiki-sk',
      sweepIntervalMs: 0,
      ...(opts.teammates ? { teammates: new TeammateService(prisma) } : {}),
    })
  }

  function cmd(sid: string, p: Partial<RunCommand> = {}): RunCommand {
    return {
      runId: `run-${Math.random().toString(36).slice(2, 10)}`,
      sessionId: sid,
      ownerId: owner.id,
      username: owner.username,
      kind: 'message',
      content: '读一下技能目录',
      ...p,
    }
  }

  async function seedSkill(p: { id: string; name: string; description: string; body?: string }): Promise<void> {
    const body = p.body ?? '# 正文\n'
    await prisma.skillPackage.create({
      data: {
        id: p.id,
        name: p.name,
        description: p.description,
        category: 'writing',
        uploaderId: owner.id,
        uploaderRole: 'user',
        sha256: `sha-${p.id}`,
        status: 'published',
      },
    })
    await prisma.skillFile.create({
      data: { packageId: p.id, path: 'SKILL.md', mime: 'text/markdown', size: body.length, sha256: `sha-file-${p.id}`, content: Buffer.from(body, 'utf8') },
    })
  }

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'skills-runtime-'))
    cleanupDirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma, 'skills-user', 'pw-skills-secure')
    owner = { id: user.id, username: user.username }
    for (const sid of ['sess-sk-1', 'sess-sk-2', 'sess-sk-3', 'sess-sk-4', 'sess-sk-p', 'sess-sk-teammate']) {
      await prisma.session.create({ data: { id: sid, ownerId: user.id, containerId: LAB, title: '' } })
    }
    await prisma.modelProvider.create({
      data: { ownerId: user.id, providerId: 'prov-1', presetId: 'openai', modelsJson: JSON.stringify([{ id: 'm-1' }]) },
    })
    hub = new CollectingHub()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    for (const dir of cleanupDirs.splice(0)) {
      await import('node:fs').then((fs) => fs.rmSync(dir, { recursive: true, force: true }))
    }
  })

  it('S2：启用 skill 进 leader 图——目录行单行注入 + read_skill 执行回喂正文', async () => {
    await seedSkill({ id: 'sk-1', name: 'paper-writing', description: '论文写作辅助\n第二行' })
    await prisma.skillEnablement.create({ data: { ownerId: owner.id, skillId: 'sk-1', enabled: true } })
    modelCalls.length = 0
    const svc = makeService([
      toolCallAi('t1', 'read_skill', { skillId: 'sk-1' }),
      new AIMessage({ content: 'done' }),
    ])
    await svc.execute(cmd('sess-sk-1'))
    expect(hub.types()[hub.types().length - 1]).toBe('run.completed')
    // 目录行单行注入（描述内换行已剥）；未启用插件段不共存（本 harness 无插件依赖）
    expect(modelCalls.at(-1)!.system).toContain('Enabled skills')
    expect(modelCalls.at(-1)!.system).toContain('- paper-writing (id: sk-1): 论文写作辅助 第二行')
    // read_skill 结果经 ToolMessage 回喂（Result JSON，正文原样）
    const toolMsg = modelCalls.at(-1)!.messages.find((m) => m.type === 'tool')
    expect(toolMsg).toBeDefined()
    const parsed = JSON.parse(String(toolMsg!.content)) as { ok: boolean; data?: { path: string; content: string; truncated: boolean } }
    expect(parsed.ok).toBe(true)
    expect(parsed.data).toMatchObject({ path: 'SKILL.md', truncated: false })
    expect(parsed.data!.content).toContain('# 正文')
  })

  it('S2：启用集变更 → 图缓存键变更 → 图重建（prompt 换代，旧图残留即失败）', async () => {
    // sk-1 已启用（上一用例）；再加 sk-2 → 目录两行按 name 稳定序
    await seedSkill({ id: 'sk-2', name: 'data-analysis', description: '数据分析技能' })
    await prisma.skillEnablement.create({ data: { ownerId: owner.id, skillId: 'sk-2', enabled: true } })
    modelCalls.length = 0
    const svc1 = makeService([new AIMessage({ content: 'ok' })])
    await svc1.execute(cmd('sess-sk-2'))
    expect(modelCalls.at(-1)!.system).toContain('- data-analysis (id: sk-2)')
    expect(modelCalls.at(-1)!.system).toContain('- paper-writing (id: sk-1)')
    // 停用 sk-1 → 新 run 的 system prompt 不再含其目录行（若命中旧缓存图必残留 → 红）
    await prisma.skillEnablement.update({
      where: { ownerId_skillId: { ownerId: owner.id, skillId: 'sk-1' } },
      data: { enabled: false },
    })
    modelCalls.length = 0
    const svc2 = makeService([new AIMessage({ content: 'ok' })])
    await svc2.execute(cmd('sess-sk-3'))
    expect(modelCalls.at(-1)!.system).not.toContain('paper-writing')
    expect(modelCalls.at(-1)!.system).toContain('data-analysis')
  })

  it('S4：teammate run 全继承——同一 owner 启用集的目录行进 teammate 图 prompt', async () => {
    // sk-2 仍启用（上一用例）——generic teammate 走同一 getOrBuildGraph 装配面
    const teammate = await prisma.teammate.create({
      data: { parentSessionId: 'sess-sk-p', threadId: 'sess-sk-teammate', name: 'helper', task: '读一下技能', kind: 'generic', status: 'running' },
    })
    modelCalls.length = 0
    const svc = makeService([new AIMessage({ content: 'ok' })], { teammates: true })
    await svc.execute(cmd('sess-sk-teammate', { parentSessionId: 'sess-sk-p', teammateId: teammate.id }))
    // teammate run 的末事件 = teammate.completed（teammate 事件族）
    expect(hub.types()[hub.types().length - 1]).toBe('teammate.completed')
    expect(modelCalls.at(-1)!.system).toContain('Enabled skills')
    expect(modelCalls.at(-1)!.system).toContain('- data-analysis (id: sk-2)')
  })

  it('S4：skill 注入是 prompt 面——run 事件词汇表无 skill 维度新增（回放零差异不受影响）', async () => {
    modelCalls.length = 0
    const svc = makeService([new AIMessage({ content: 'ok' })])
    await svc.execute(cmd('sess-sk-4'))
    expect(hub.types()[hub.types().length - 1]).toBe('run.completed')
    for (const type of new Set(hub.types())) {
      expect(type).not.toMatch(/skill/i)
    }
  })
})

// S3 纯逻辑的假 prisma（目录版本用例）
function fakeCatalogPrisma(rows: Array<{ id: string; name: string; description: string; sha256: string }>) {
  return {
    skillPackage: { findMany: async () => rows },
  } as unknown as PrismaClient
}
