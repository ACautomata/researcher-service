// wiki 治理生成生命周期工具 + 全局串行锁 + 组合 backend 单测（#790 · S3 纯逻辑/契约面）。
//   - 生命周期工具按名挑六（检索四工具 openwiki_list_workspaces/list_wikis/search/read 不在
//     面内——避免与 #789 常驻检索重复）；begin 模型面 schema 键集（mode/language/force，无
//     root——root 注入镜像根）；Result 永不 throw（HostIntegrationError → error.code 映射）；
//     finish 钩子追加 base-hash 复检 + 推回，冲突 Result 原样返回。
//   - 全局串行锁（AC4 并发保护验证）：并发 N 严格串行次序化、异常后锁释放可再入。
//   - 组合 backend（CompositeBackend(DockerArchiveBackend, {'/wiki/': FilesystemBackend}) 经
//     withWriteLocks 整体包裹）：/lab 写持 #785 写锁（锁面不因组合丢失）、/wiki 写落镜像、
//     /wiki 写也入锁。

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostIntegrationError } from 'openwiki/dist/integrations/core/errors.js'
import { HostSessionManager } from 'openwiki/dist/integrations/core/session-manager.js'
import { FilesystemBackend } from 'deepagents'
import { createWikiLifecycleTools, WIKI_LIFECYCLE_TOOL_NAMES } from '../src/runner/wikigen/lifecycleTools'
import { buildWikiUpdateBackend } from '../src/runner/wikigen/backend'
import { SerialRunGate } from '../src/wiki/updateRun'
import { WriteLockRegistry } from '../src/runner/writelock/registry'
import { withWriteLocks } from '../src/runner/writelock/lockedBackend'
import type { ProtocolTool, ProtocolToolName } from 'openwiki/dist/integrations/core/protocol.js'
import type { SandboxBackendProtocolV2 } from '../src/runner/backend/protocol'

const cleanups: Array<() => void> = []
afterAll(() => { for (const c of cleanups.splice(0)) c() })

// ---------------------------------------------------------------------------
// 假 HostSessionManager：只实现 tools()（wrapper 只依赖该面 + handle 行为）
// ---------------------------------------------------------------------------

interface RecordedCall {
  name: ProtocolToolName
  input: unknown
}

function fakeManager(handles: Partial<Record<ProtocolToolName, (input: unknown) => Promise<unknown>>>): {
  manager: HostSessionManager
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const tools: ProtocolTool[] = WIKI_LIFECYCLE_TOOL_NAMES.map((name) => ({
    name,
    description: `fake ${name}`,
    schema: { parse: (v: unknown) => v } as ProtocolTool['schema'],
    handle: async (input: unknown) => {
      calls.push({ name, input })
      const h = handles[name]
      if (!h) return { name }
      return h(input)
    },
  }))
  const manager = { tools: () => tools } as unknown as HostSessionManager
  return { manager, calls }
}

describe('createWikiLifecycleTools（#790 生命周期工具包装）', () => {
  it('真实 openwiki HostSessionManager 工具面 = 4 检索 + 6 生命周期；包装按名挑六（deep-import 契约锁定）', () => {
    const real = HostSessionManager.create({ host: 'panel-wiki-update' })
    const all = real.tools().map((t) => t.name)
    expect(all).toHaveLength(10)
    expect(all).toEqual(expect.arrayContaining([
      'openwiki_list_workspaces', 'openwiki_list_wikis', 'openwiki_search', 'openwiki_read',
    ]))
    const wrapped = createWikiLifecycleTools({
      manager: real,
      mirrorRoot: '/tmp/unused',
      onFinished: async () => ({ ok: true, data: {} }),
    })
    expect(wrapped.map((t) => t.name).sort()).toEqual([
      'openwiki_begin', 'openwiki_finish', 'openwiki_inspect_page_claims',
      'openwiki_next_page', 'openwiki_submit_page', 'openwiki_submit_plan',
    ])
  })

  it('begin 模型面 schema 键集 = [force, language, mode]（root 已注入裁掉）；handle 收到注入的镜像根', async () => {
    const { manager, calls } = fakeManager({})
    const [begin] = createWikiLifecycleTools({ manager, mirrorRoot: '/tmp/mirror-x', onFinished: async () => ({ ok: true, data: {} }) })
    const shape = (begin!.schema as unknown as { shape: Record<string, unknown> }).shape
    expect(Object.keys(shape).sort()).toEqual(['force', 'language', 'mode'])
    expect(Object.keys(shape)).not.toContain('root')
    const raw = await begin!.invoke({ mode: 'update' })
    expect(JSON.parse(raw as string)).toEqual({ ok: true, data: { name: 'openwiki_begin' } })
    expect(calls[0]).toMatchObject({ name: 'openwiki_begin', input: { mode: 'update', root: '/tmp/mirror-x' } })
  })

  it('Result 永不 throw：HostIntegrationError → error.code 映射（invalid_state/conflict）；未知异常 → internal', async () => {
    const { manager } = fakeManager({
      openwiki_next_page: async () => { throw new HostIntegrationError('invalid_state', 'No matching OpenWiki run is active.') },
      openwiki_submit_plan: async () => { throw new HostIntegrationError('conflict', 'plan conflict') },
      openwiki_submit_page: async () => { throw new Error('boom') },
    })
    const tools = createWikiLifecycleTools({ manager, mirrorRoot: '/tmp/x', onFinished: async () => ({ ok: true, data: {} }) })
    const byName = new Map(tools.map((t) => [t.name, t]))
    const nextPage = JSON.parse((await byName.get('openwiki_next_page')!.invoke({ runId: 'r' })) as string) as { ok: boolean; error: { code: string } }
    expect(nextPage).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
    const plan = JSON.parse((await byName.get('openwiki_submit_plan')!.invoke({ runId: 'r', pages: [] })) as string) as { ok: boolean; error: { code: string } }
    expect(plan).toMatchObject({ ok: false, error: { code: 'conflict' } })
    const page = JSON.parse((await byName.get('openwiki_submit_page')!.invoke({ runId: 'r', jobId: 'j' })) as string) as { ok: boolean; error: { code: string } }
    expect(page).toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  it('finish 钩子：manager.finish 落定后调 onFinished（复检+推回）并合并结果；冲突 Result 原样返回不合并', async () => {
    let finishCalls = 0
    const { manager, calls } = fakeManager({
      openwiki_finish: async () => { finishCalls += 1; return { status: 'complete' } },
    })
    let onFinishedCalls = 0
    const tools = createWikiLifecycleTools({
      manager,
      mirrorRoot: '/tmp/x',
      onFinished: async () => { onFinishedCalls += 1; return { ok: true, data: { pushedFiles: 3, removedFiles: [] } } },
    })
    const finish = tools.find((t) => t.name === 'openwiki_finish')!
    const raw = await finish.invoke({ runId: 'r1' })
    expect(JSON.parse(raw as string)).toEqual({
      ok: true,
      data: { finish: { status: 'complete' }, push: { pushedFiles: 3, removedFiles: [] } },
    })
    expect(finishCalls).toBe(1)
    expect(onFinishedCalls).toBe(1)
    expect(calls[0]!.name).toBe('openwiki_finish')

    // 冲突：onFinished 返回 conflict Result → finish 原样返回（不推回语义由 onFinished 兑现）
    const tools2 = createWikiLifecycleTools({
      manager: fakeManager({ openwiki_finish: async () => ({ status: 'complete' }) }).manager,
      mirrorRoot: '/tmp/x',
      onFinished: async () => ({ ok: false, error: { code: 'conflict', message: 'wiki changed underneath' } }),
    })
    const finish2 = tools2.find((t) => t.name === 'openwiki_finish')!
    const raw2 = await finish2.invoke({ runId: 'r1' })
    expect(JSON.parse(raw2 as string)).toEqual({ ok: false, error: { code: 'conflict', message: 'wiki changed underneath' } })
  })
})

describe('SerialRunGate（#790 全局串行锁 · AC4 并发保护）', () => {
  it('并发 N 个 acquire 严格串行次序化（前一任务未完，后一任务不启动）', async () => {
    const gate = new SerialRunGate()
    const trace: string[] = []
    let release1!: () => void
    const latch1 = new Promise<void>((r) => { release1 = r })
    const t1 = gate.run(async () => { trace.push('s1'); await latch1; trace.push('e1') })
    const t2 = gate.run(async () => { trace.push('s2'); trace.push('e2') })
    const t3 = gate.run(async () => { trace.push('s3'); trace.push('e3') })
    await Promise.resolve()
    await Promise.resolve()
    expect(trace).toEqual(['s1']) // t2/t3 被 t1 串行挡住
    release1()
    await Promise.all([t1, t2, t3])
    expect(trace).toEqual(['s1', 'e1', 's2', 'e2', 's3', 'e3'])
  })

  it('异常后锁释放可再入（错误不锁死后续任务）；错误向上传播给各自调用方', async () => {
    const gate = new SerialRunGate()
    await expect(gate.run(async () => { throw new Error('first fails') })).rejects.toThrow('first fails')
    const trace: string[] = []
    await gate.run(async () => { trace.push('after-failure') })
    expect(trace).toEqual(['after-failure'])
  })
})

describe('buildWikiUpdateBackend（#790 组合 backend）', () => {
  it('/lab 写经组合 backend 仍持 #785 写锁（锁面不因 CompositeBackend 组合丢失）；/wiki 写落镜像、不触容器 backend', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wikigen-backend-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const locks = new WriteLockRegistry({ timeoutMs: 1000 })
    const labWrites: string[] = []
    let release!: () => void
    const latch = new Promise<void>((r) => { release = r })
    const blockingDefault = {
      id: 'fake-default',
      write: async (filePath: string) => {
        labWrites.push(filePath)
        await latch
        return { path: filePath, filesUpdate: null }
      },
    } as unknown as SandboxBackendProtocolV2
    const backend = buildWikiUpdateBackend({
      defaultBackend: blockingDefault, // 注入缝：RunService 传 DockerArchiveBackend，测试注阻塞 fake 观察锁面
      wikiRouteBackend: new FilesystemBackend({ rootDir: dir, virtualMode: true }),
      targets: { wiki: 'researcher-wiki-u1', lab: 'researcher-sandbox-s1' },
      locks,
      ctx: () => ({ session: 's1', threadId: 's1', holder: { label: 'test' } }),
    })
    const pending = backend.write('/lab/notes.md', 'x')
    await Promise.resolve()
    await Promise.resolve()
    expect(locks.held()).toEqual([expect.objectContaining({ session: 's1', path: 'lab/notes.md' })])
    release()
    await pending
    expect(locks.held()).toEqual([])
    expect(labWrites).toEqual(['/lab/notes.md'])

    // /wiki 写：落 FilesystemBackend（镜像 tmp 树），不经默认 backend（容器面）
    const wikiWrite = await backend.write('/wiki/concepts/demo.md', '# hello\n')
    expect(wikiWrite).not.toHaveProperty('error')
    expect(statSync(join(dir, 'concepts', 'demo.md')).isFile()).toBe(true)
    expect(readFileSync(join(dir, 'concepts', 'demo.md'), 'utf8')).toBe('# hello\n')
    expect(labWrites).toEqual(['/lab/notes.md'])
  })

  it('/wiki 写在锁内（withWriteLocks 整体包裹面，held 可观测）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wikigen-backend2-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const locks = new WriteLockRegistry({ timeoutMs: 1000 })
    let releaseWiki!: () => void
    const latch = new Promise<void>((r) => { releaseWiki = r })
    const inner = new FilesystemBackend({ rootDir: dir, virtualMode: true })
    const slowWiki = {
      id: 'slow-wiki',
      write: async (filePath: string, content: string) => {
        await latch
        return inner.write(filePath, content)
      },
    } as unknown as SandboxBackendProtocolV2
    const wrapped = withWriteLocks(
      slowWiki,
      { wiki: 'researcher-wiki-u1', lab: 'researcher-sandbox-s1' },
      locks,
      () => ({ session: 's1', threadId: 's1', holder: { label: 'test' } }),
    )
    const pending = wrapped.write('/wiki/concepts/a.md', 'x')
    await Promise.resolve()
    await Promise.resolve()
    expect(locks.held()).toEqual([expect.objectContaining({ path: 'wiki/concepts/a.md' })])
    releaseWiki()
    await pending
    expect(locks.held()).toEqual([])
  })
})
