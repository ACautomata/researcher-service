// S2/S3 混合单测（#785 锁面接线）：withWriteLocks 后端装饰器（写锁/读/bash 旁路/超时错误面）
// + withLockedPuts 原语装饰器（ingestion/校验节点 putArchive 文件级锁）+ 覆盖审计判定。
// backend = 真 DockerArchiveBackend over fakePrimitives（内存 tar 树）——锁行为在真方法上验证。

import { describe, it, expect, vi } from 'vitest'
import { DockerArchiveBackend } from '../src/runner/backend/dockerArchiveBackend'
import type { SandboxFilePrimitives } from '../src/runner/backend/primitives'
import { withWriteLocks, withLockedPuts, toLockKey } from '../src/runner/writelock/lockedBackend'
import { WriteLockRegistry, WriteLockTimeoutError } from '../src/runner/writelock/registry'
import { OverwriteAuditor, type JournalWriterReader, type OverwriteAuditSink } from '../src/runner/writelock/overwriteAudit'
import { createTarFile, createTarTree } from '../src/files/tar'
import { fakePrimitives } from './runnerFakes'

const TARGETS = { wiki: 'researcher-wiki-u1', lab: 'researcher-sandbox-s1' }
const SESSION = 'sess-1'

// fakePrimitives 的 trees 惰性建树——直接 get()?.set() 会静默 no-op，种子须先建容器树。
function seedFile(trees: Map<string, Map<string, Buffer | 'dir'>>, container: string, path: string, content: string): void {
  let t = trees.get(container)
  if (!t) {
    t = new Map()
    trees.set(container, t)
  }
  t.set(path, Buffer.from(content))
}

function ctxHolder(holder = 'run r1 (thread sess-1)', runId = 'r1') {
  return () => ({ session: SESSION, threadId: 'sess-1', holder: { label: holder, runId } })
}

function makeLockedBackend(
  primitives: SandboxFilePrimitives,
  locks: WriteLockRegistry,
  auditor?: OverwriteAuditor,
) {
  return withWriteLocks(new DockerArchiveBackend(primitives, TARGETS), TARGETS, locks, ctxHolder(), auditor)
}

// withLockedPuts 用 ctx（run 身份齐全——覆盖审计 detect 面）
function ctxOf(session = SESSION, threadId = 'sess-1', label = 'run r1') {
  return () => ({ session, threadId, holder: { label, runId: 'r1' } })
}

describe('withWriteLocks（#785 后端锁面）', () => {
  it('write 加锁：同 path 被外部持锁 → {error} 含原始 path 与持有者；释放后成功', async () => {
    const { primitives, trees } = fakePrimitives()
    const locks = new WriteLockRegistry({ timeoutMs: 30 })
    const backend = makeLockedBackend(primitives, locks)
    const external = await locks.acquire(SESSION, 'lab/notes/a.txt', { label: 'teammate run r9' })

    const blocked = await backend.write('/lab/notes/a.txt', 'hello')
    expect('error' in blocked && blocked.error).toContain('/lab/notes/a.txt')
    expect('error' in blocked && blocked.error).toContain('teammate run r9')
    expect('error' in blocked && blocked.error).toContain('waited 30ms')
    expect(trees.get(TARGETS.lab)?.has('/lab/notes/a.txt')).toBeFalsy()

    external.release()
    const ok = await backend.write('/lab/notes/a.txt', 'hello')
    expect('error' in ok).toBe(false)
    expect(trees.get(TARGETS.lab)?.get('/lab/notes/a.txt')).instanceof(Buffer)
  })

  it('edit 全读改写序在锁内：外部持锁期间 edit 被挡，释放后正常替换', async () => {
    const { primitives, trees } = fakePrimitives()
    seedFile(trees, TARGETS.lab, '/lab/a.txt', 'hello world')
    const locks = new WriteLockRegistry({ timeoutMs: 30 })
    const backend = makeLockedBackend(primitives, locks)
    const external = await locks.acquire(SESSION, 'lab/a.txt', { label: 'holder-x' })
    const blocked = await backend.edit('/lab/a.txt', 'world', 'there')
    expect('error' in blocked && blocked.error).toContain('holder-x')
    external.release()
    const ok = await backend.edit('/lab/a.txt', 'world', 'there')
    expect('error' in ok).toBe(false)
    expect((trees.get(TARGETS.lab)?.get('/lab/a.txt') as Buffer).toString()).toBe('hello there')
  })

  it('delete 加锁：外部持锁期间 {error} 含持有者；释放后删除成功', async () => {
    const { primitives, trees } = fakePrimitives()
    seedFile(trees, TARGETS.lab, '/lab/a.txt', 'x')
    const locks = new WriteLockRegistry({ timeoutMs: 30 })
    const backend = makeLockedBackend(primitives, locks)
    const external = await locks.acquire(SESSION, 'lab/a.txt', { label: 'holder-y' })
    const blocked = await backend.delete!('/lab/a.txt')
    expect('error' in blocked && blocked.error).toContain('holder-y')
    external.release()
    expect('error' in (await backend.delete!('/lab/a.txt'))).toBe(false)
    // 删除副作用（rm -rf exec）的树面归 dockerArchiveBackend.test.ts 锁定——此处断言锁释放纪律
    expect(locks.held()).toEqual([])
  })

  it('读路径不受锁阻塞：外部持锁期间 read/ls/glob/grep 正常返回', async () => {
    const { primitives, trees } = fakePrimitives()
    seedFile(trees, TARGETS.lab, '/lab/a.txt', 'readable')
    const locks = new WriteLockRegistry({ timeoutMs: 30 })
    const backend = makeLockedBackend(primitives, locks)
    const external = await locks.acquire(SESSION, 'lab/a.txt', { label: 'holder-z' })

    const read = await backend.read('/lab/a.txt')
    expect('error' in read).toBe(false)
    const ls = await backend.ls('/lab')
    expect('error' in ls).toBe(false)
    const glob = await backend.glob('*.txt', '/lab')
    expect('error' in glob).toBe(false)
    const grep = await backend.grep('readable', '/lab')
    expect('error' in grep).toBe(false)
    external.release()
  })

  it('bash 旁路不受锁约束：外部持锁期间 execute 正常执行', async () => {
    const { primitives } = fakePrimitives()
    const locks = new WriteLockRegistry({ timeoutMs: 30 })
    const backend = makeLockedBackend(primitives, locks)
    const external = await locks.acquire(SESSION, 'lab/anything', { label: 'holder-bash' })
    const r = await backend.execute('echo hi')
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain('fake-exec-out')
    external.release()
  })

  it('非法路径不加锁直通底层错误面；锁表无残留', async () => {
    const { primitives } = fakePrimitives()
    const locks = new WriteLockRegistry({ timeoutMs: 30 })
    const backend = makeLockedBackend(primitives, locks)
    const r = await backend.write('relative/path.txt', 'x')
    expect('error' in r && r.error).toContain('invalid path')
    expect(locks.held()).toEqual([])
  })

  it('并发写同 path 串行化：两次 write 都成功，后写覆盖（合法覆盖，无超时）', async () => {
    const { primitives, trees } = fakePrimitives()
    const locks = new WriteLockRegistry({ timeoutMs: 5000 })
    const backend = makeLockedBackend(primitives, locks)
    const [r1, r2] = await Promise.all([
      backend.write('/lab/hot.txt', 'first'),
      backend.write('/lab/hot.txt', 'second'),
    ])
    expect('error' in r1).toBe(false)
    expect('error' in r2).toBe(false)
    expect((trees.get(TARGETS.lab)?.get('/lab/hot.txt') as Buffer).toString()).toBe('second')
    expect(locks.held()).toEqual([])
  })

  it('锁 key 归一化：/lab//a/./b 与 /lab/a/b 同 key 互斥', async () => {
    expect(toLockKey('/lab/a/b')).toBe('lab/a/b')
    const { primitives } = fakePrimitives()
    const locks = new WriteLockRegistry({ timeoutMs: 30 })
    const backend = makeLockedBackend(primitives, locks)
    const external = await locks.acquire(SESSION, 'lab/a/b', { label: 'norm-holder' })
    const blocked = await backend.write('/lab//a/./b', 'x')
    expect('error' in blocked && blocked.error).toContain('norm-holder')
    external.release()
  })

  it('op 结束即释放：write 成功后锁表清空（无泄漏）', async () => {
    const { primitives } = fakePrimitives()
    const locks = new WriteLockRegistry({ timeoutMs: 1000 })
    const backend = makeLockedBackend(primitives, locks)
    await backend.write('/lab/x.txt', 'x')
    expect(locks.held()).toEqual([])
  })
})

describe('覆盖审计（OverwriteAuditor · #785 语义层，detect/record 两段式）', () => {
  function makeAuditor(writerThread: string | null, failSink = false, failReader = false): {
    auditor: OverwriteAuditor
    recorded: unknown[]
    readerCalls: Array<{ sessionId: string; path: string }>
  } {
    const recorded: unknown[] = []
    const readerCalls: Array<{ sessionId: string; path: string }> = []
    const reader: JournalWriterReader = {
      async latestAppliedWriterThread(sessionId, path) {
        if (failReader) throw new Error('db down')
        readerCalls.push({ sessionId, path })
        return writerThread
      },
    }
    const sink: OverwriteAuditSink = {
      async record(row) {
        if (failSink) throw new Error('db down')
        recorded.push(row)
      },
    }
    return { auditor: new OverwriteAuditor(reader, sink), recorded, readerCalls }
  }

  it('detect：上家 writer ≠ 本 thread → 待记录行（path/覆盖者/被覆盖者）；record 落行', async () => {
    const { auditor, recorded, readerCalls } = makeAuditor('teammate-thread-7')
    const row = await auditor.detect({ sessionId: 'sess-1', path: 'lab/a.txt', threadId: 'sess-1', runId: 'r1' })
    expect(readerCalls).toEqual([{ sessionId: 'sess-1', path: 'lab/a.txt' }])
    expect(row).toEqual({
      sessionId: 'sess-1',
      path: 'lab/a.txt',
      overwriterThreadId: 'sess-1',
      overwrittenThreadId: 'teammate-thread-7',
      runId: 'r1',
    })
    await auditor.record(row!)
    expect(recorded).toEqual([row])
  })

  it('detect：上家 = 本 thread（fork 继承形态）/ 无 journal 行 / 无 runId（label-only holder）→ null', async () => {
    const same = makeAuditor('sess-1')
    expect(await same.auditor.detect({ sessionId: 'sess-1', path: 'lab/a.txt', threadId: 'sess-1', runId: 'r1' })).toBeNull()
    const none = makeAuditor(null)
    expect(await none.auditor.detect({ sessionId: 'sess-1', path: 'lab/a.txt', threadId: 'sess-1', runId: 'r1' })).toBeNull()
    const noRun = makeAuditor('other-thread')
    expect(await noRun.auditor.detect({ sessionId: 'sess-1', path: 'lab/a.txt', threadId: 'sess-1' })).toBeNull()
    expect(await noRun.auditor.detect({ sessionId: 'sess-1', path: 'lab/a.txt', threadId: 'sess-1', runId: '' })).toBeNull()
  })

  it('审计读/写失败不阻断写路径（fail-soft + warn 留痕——静默失败不可接受）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failedRead = makeAuditor('other-thread', false, true)
    await expect(
      failedRead.auditor.detect({ sessionId: 'sess-1', path: 'lab/a.txt', threadId: 'sess-1', runId: 'r1' }),
    ).resolves.toBeNull()
    const failedWrite = makeAuditor('other-thread', true)
    const row = await failedWrite.auditor.detect({ sessionId: 'sess-1', path: 'lab/a.txt', threadId: 'sess-1', runId: 'r1' })
    await expect(failedWrite.auditor.record(row!)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('接线形态：withWriteLocks 在锁内 detect、op 成功后 record', async () => {
    const { primitives } = fakePrimitives()
    const { auditor, recorded } = makeAuditor('teammate-thread-7')
    const locks = new WriteLockRegistry({ timeoutMs: 1000 })
    const backend = makeLockedBackend(primitives, locks, auditor)
    await backend.write('/lab/a.txt', 'x')
    expect(recorded).toHaveLength(1)
  })

  it('op 失败不落幻影行：backend {error}（锁内失败）→ detect 命中而 record 不落', async () => {
    const { primitives } = fakePrimitives()
    const { auditor, recorded } = makeAuditor('teammate-thread-7')
    const locks = new WriteLockRegistry({ timeoutMs: 1000 })
    const backend = makeLockedBackend(primitives, locks, auditor)
    // 不存在的路径上的 edit：锁取得、detect 命中、op 返回 {error} → 不 record
    const r = await backend.edit('/lab/ghost.txt', 'a', 'b')
    expect('error' in r && r.error).toBeTruthy()
    expect(recorded).toHaveLength(0)
  })

  it('withLockedPuts 接线形态：putArchive 成功后 record（path = tar 文件 key）', async () => {
    const { primitives } = fakePrimitives()
    const { auditor, recorded } = makeAuditor('teammate-thread-7')
    const locks = new WriteLockRegistry({ timeoutMs: 1000 })
    const locked = withLockedPuts(primitives, locks, ctxOf(), auditor)
    await locked.putArchive(TARGETS.lab, '/lab/uploads/a1', createTarFile('file.txt', Buffer.from('x')))
    expect(recorded).toHaveLength(1)
    expect((recorded[0] as { path: string }).path).toBe('lab/uploads/a1/file.txt')
  })
})

describe('withLockedPuts（#785 ingestion/校验节点锁面）', () => {
  it('putArchive 按 tar 内文件名取文件级锁：同 path 被持锁 → 上抛超时；释放后落盘', async () => {
    const { primitives, trees } = fakePrimitives()
    const locks = new WriteLockRegistry({ timeoutMs: 30 })
    const locked = withLockedPuts(primitives, locks, ctxOf())
    const external = await locks.acquire(SESSION, 'lab/uploads/a1/file.txt', { label: 'tool-holder' })

    await expect(
      locked.putArchive(TARGETS.lab, '/lab/uploads/a1', createTarFile('file.txt', Buffer.from('bytes'))),
    ).rejects.toBeInstanceOf(WriteLockTimeoutError)
    external.release()
    await locked.putArchive(TARGETS.lab, '/lab/uploads/a1', createTarFile('file.txt', Buffer.from('bytes')))
    expect((trees.get(TARGETS.lab)?.get('/lab/uploads/a1/file.txt') as Buffer).toString()).toBe('bytes')
    expect(locks.held()).toEqual([])
  })

  it('不同文件名不同 key：同目录并发 putArchive 互不阻塞', async () => {
    const { primitives } = fakePrimitives()
    const locks = new WriteLockRegistry({ timeoutMs: 30 })
    const locked = withLockedPuts(primitives, locks, ctxOf())
    const external = await locks.acquire(SESSION, 'lab/uploads/a1/one.txt', { label: 'other' })
    await locked.putArchive(TARGETS.lab, '/lab/uploads/a1', createTarFile('two.txt', Buffer.from('x')))
    external.release()
  })

  it('非单文件 tar → 退化为目录级 key（宁粗勿漏——多条目不得只锁首条目文件名）', async () => {
    const { primitives } = fakePrimitives()
    const locks = new WriteLockRegistry({ timeoutMs: 30 })
    const locked = withLockedPuts(primitives, locks, ctxOf())
    const external = await locks.acquire(SESSION, 'lab/uploads/a1', { label: 'dir-holder' })
    // 目录 tar（多条目）：首条目名不得成为锁 key——目录级 key 命中外部持有者
    await expect(
      locked.putArchive(
        TARGETS.lab,
        '/lab/uploads/a1',
        createTarTree([
          { name: 'a.txt', type: 'file', content: Buffer.from('a') },
          { name: 'b.txt', type: 'file', content: Buffer.from('b') },
        ]),
      ),
    ).rejects.toBeInstanceOf(WriteLockTimeoutError)
    external.release()
  })

  it('exec/getArchive 直通（mkdir 非破坏性 + 读不限）', async () => {
    const { primitives, trees } = fakePrimitives()
    seedFile(trees, TARGETS.lab, '/lab/uploads/a1/f.txt', 'x')
    const locks = new WriteLockRegistry({ timeoutMs: 30 })
    const locked = withLockedPuts(primitives, locks, ctxOf())
    const exec = await locked.exec(TARGETS.lab, ['mkdir', '-p', '/lab/uploads/a2'])
    expect(exec.exitCode).toBe(0)
    const buf = await locked.getArchive(TARGETS.lab, '/lab/uploads/a1/f.txt')
    expect(buf).instanceof(Buffer)
  })
})
