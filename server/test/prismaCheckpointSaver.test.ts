// #774 [#747·04] PrismaCheckpointSaver —— BaseCheckpointSaver 五方法 × 真 SQLite（S3 纯逻辑单测）。
//
// 验收依据（逐条对齐 #774 Acceptance criteria）：
//   - 「五方法对 SQLite 全量单测（S3）：写入/读取/分支/删除 thread 级联」
//   - 「与 LangGraph SDK 的接口契约核对通过（版本锁定集内）」——@langchain/langgraph-checkpoint ~1.1.5
//     （对齐 @langchain/langgraph ~1.4.18 内部依赖 ^1.1.5，#747 A 节版本锁定集）
//   - 行为参照：同包 MemorySaver（官方 saver 语义对照，723 §1 接口调研）
//   - PoC 三坑之三：WRITES_IDX_MAP 仅从 checkpoint 包导出（负 idx 行为用例锁定）
//   - #747 B 节 retention：deleteThread 清机制数据（sessions 行是产品面，不动）
//
// 接缝：S3 纯逻辑单测——真 SQLite 临时库（#771 apply-schema 建库）+ PrismaClient 注入，
// 零 mock；不测 Prisma 内部，测「行形状 ⇄ LangGraph checkpoint 语义」双向映射。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BaseCheckpointSaver, WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint'
import type { Checkpoint, CheckpointMetadata, CheckpointTuple } from '@langchain/langgraph-checkpoint'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { runDbScript } from './runDbScript'
import { PrismaCheckpointSaver } from '../src/runner/persistence/prismaCheckpointSaver'

const OWNER = 'owner-saver-1'

function makeCheckpoint(id: string, partial: Partial<Checkpoint> = {}): Checkpoint {
  return {
    v: 4,
    id,
    ts: '2026-10-01T00:00:00.000Z',
    channel_values: {},
    channel_versions: {},
    versions_seen: {},
    ...partial,
  }
}

function makeMetadata(partial: Partial<CheckpointMetadata> & Record<string, unknown> = {}): CheckpointMetadata {
  return { source: 'loop', step: 0, parents: {}, ...partial }
}

// list 契约是 AsyncGenerator（官方 saver 签名）——测试侧收集为数组再断言
async function collectList(gen: AsyncGenerator<CheckpointTuple>): Promise<CheckpointTuple[]> {
  const out: CheckpointTuple[] = []
  for await (const t of gen) out.push(t)
  return out
}

describe('PrismaCheckpointSaver（#774 · S3 · 真 SQLite）', () => {
  let dbDir: string
  let prisma: PrismaClient
  let saver: PrismaCheckpointSaver

  beforeAll(() => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'ckpt-saver-test-'))
    const dbPath = path.join(dbDir, 'test.db')
    runDbScript('apply-schema.mjs', dbPath)
    prisma = createPrismaClient(`file:${dbPath}`)
    saver = new PrismaCheckpointSaver(prisma)
  })

  beforeEach(async () => {
    // 每用例清机制数据（sessions/users 行保留，FK 不重建）
    await prisma.checkpointWrite.deleteMany({})
    await prisma.checkpoint.deleteMany({})
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dbDir, { recursive: true, force: true })
  })

  /** 建 thread（Session 行，checkpoints.threadId FK 落点） */
  async function seedThread(id: string): Promise<void> {
    await prisma.user.upsert({
      where: { id: OWNER },
      update: {},
      create: { id: OWNER, username: 'saver-owner' },
    })
    await prisma.session.upsert({
      where: { id },
      update: {},
      create: { id, ownerId: OWNER, containerId: `sandbox-${id}` },
    })
  }

  it('契约：instanceof BaseCheckpointSaver + 默认 JsonPlusSerializer serde', async () => {
    expect(saver).toBeInstanceOf(BaseCheckpointSaver)
    // JsonPlusSerializer 证据：Uint8Array 等特殊类型 dumpsTyped/loadsTyped round-trip 还原
    // （普通 JSON.stringify 只会得到 {"0":1,...} 展平对象——{"lc":2,...constructor...} 标记是 jsonplus 独有）
    const [type, blob] = await saver.serde.dumpsTyped({ bin: new Uint8Array([1, 2, 3]) })
    expect(type).toBe('json')
    expect(new TextDecoder().decode(blob)).toContain('"lc":2')
    const restored = (await saver.serde.loadsTyped(type, blob)) as { bin: Uint8Array }
    expect(restored.bin).toBeInstanceOf(Uint8Array)
    expect(Array.from(restored.bin)).toEqual([1, 2, 3])
  })

  it('put → getTuple 按 checkpoint_id 精确回读（values/metadata/serde blob round-trip）', async () => {
    const threadId = 't-put-roundtrip'
    await seedThread(threadId)
    const checkpoint = makeCheckpoint('ckpt-a1', {
      channel_values: { messages: [{ lc: 1, id: ['msg', 1] }], scratch: 42 },
      channel_versions: { messages: 3, scratch: 1 },
      versions_seen: { nodeA: { messages: 2 } },
    })
    const metadata = makeMetadata({ source: 'input', step: -1, custom: 'keep-me' })

    const ret = await saver.put(
      { configurable: { thread_id: threadId } },
      checkpoint,
      metadata,
      { messages: 3, scratch: 1 },
    )

    // put 返回新 checkpoint 的寻址 config（官方语义）
    expect(ret).toEqual({
      configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'ckpt-a1' },
    })

    const tuple = await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_id: 'ckpt-a1' },
    })
    expect(tuple).toBeDefined()
    expect(tuple!.checkpoint).toEqual(checkpoint)
    expect(tuple!.metadata).toEqual(metadata)
    // 官方语义：config 按 checkpoint_id 精确寻址时原样回显调用方传入的 config
    expect(tuple!.config).toEqual({
      configurable: { thread_id: threadId, checkpoint_id: 'ckpt-a1' },
    })
    // 首 checkpoint 无父
    expect(tuple!.parentConfig).toBeUndefined()
    expect(tuple!.pendingWrites).toEqual([])
  })

  it('blob 落库为 serde 字节（dumpsTyped 双件 type/blob 进两列）', async () => {
    const threadId = 't-blob-shape'
    await seedThread(threadId)
    await saver.put(
      { configurable: { thread_id: threadId } },
      makeCheckpoint('ckpt-blob', { channel_values: { x: 'y' } }),
      makeMetadata(),
      {},
    )
    const row = await prisma.checkpoint.findUnique({
      where: {
        threadId_checkpointNs_checkpointId: {
          threadId,
          checkpointNs: '',
          checkpointId: 'ckpt-blob',
        },
      },
    })
    expect(row).not.toBeNull()
    expect(row!.type).toBe('json')
    // 字节可被 serde 反序列化回同语义（不依赖 Prisma 内部表示，先归一为 Uint8Array）
    const raw = new Uint8Array(row!.blob as Uint8Array)
    expect(await saver.serde.loadsTyped(row!.type, raw)).toEqual(
      makeCheckpoint('ckpt-blob', { channel_values: { x: 'y' } }),
    )
  })

  it('getTuple 无 checkpoint_id → 返回该 thread 最新（id 字典序倒序 = 时间序）', async () => {
    const threadId = 't-latest'
    await seedThread(threadId)
    await saver.put(
      { configurable: { thread_id: threadId } },
      makeCheckpoint('20261001-000001-aaaa'),
      makeMetadata({ step: 0 }),
      {},
    )
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_id: '20261001-000001-aaaa' } },
      makeCheckpoint('20261001-000002-bbbb'),
      makeMetadata({ step: 1 }),
      {},
    )
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_id: '20261001-000002-bbbb' } },
      makeCheckpoint('20261001-000000-zzzz'), // 字典序更早 → 不应被当作「最新」
      makeMetadata({ step: 99 }),
      {},
    )

    const tuple = await saver.getTuple({ configurable: { thread_id: threadId } })
    expect(tuple!.checkpoint.id).toBe('20261001-000002-bbbb')
    expect(tuple!.metadata!.step).toBe(1)
    // 精确寻址不受倒序逻辑影响
    const exact = await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_id: '20261001-000000-zzzz' },
    })
    expect(exact!.checkpoint.id).toBe('20261001-000000-zzzz')
  })

  it('父子链：parentCheckpointId 落表，getTuple 逐级给 parentConfig（分支真相源）', async () => {
    const threadId = 't-parent-chain'
    await seedThread(threadId)
    await saver.put(
      { configurable: { thread_id: threadId } },
      makeCheckpoint('chain-1'),
      makeMetadata({ step: 0 }),
      {},
    )
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_id: 'chain-1' } },
      makeCheckpoint('chain-2'),
      makeMetadata({ step: 1, parents: { '': 'chain-1' } }),
      {},
    )
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_id: 'chain-2' } },
      makeCheckpoint('chain-3'),
      makeMetadata({ step: 2, parents: { '': 'chain-2' } }),
      {},
    )

    const t3 = await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_id: 'chain-3' },
    })
    expect(t3!.parentConfig).toEqual({
      configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'chain-2' },
    })
    const t2 = await saver.getTuple(t3!.parentConfig!)
    expect(t2!.parentConfig).toEqual({
      configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'chain-1' },
    })
    const t1 = await saver.getTuple(t2!.parentConfig!)
    expect(t1!.parentConfig).toBeUndefined()

    // 行形状：parentCheckpointId 列原样落库
    const row = await prisma.checkpoint.findUnique({
      where: {
        threadId_checkpointNs_checkpointId: { threadId, checkpointNs: '', checkpointId: 'chain-3' },
      },
    })
    expect(row!.parentCheckpointId).toBe('chain-2')
  })

  it('checkpointNs 隔离：同 thread 不同 ns 各自成树', async () => {
    const threadId = 't-ns-isolation'
    await seedThread(threadId)
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_ns: '' } },
      makeCheckpoint('ns-root'),
      makeMetadata({ step: 0 }),
      {},
    )
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_ns: 'subgraph-1', checkpoint_id: 'ns-sub' } },
      makeCheckpoint('ns-sub'),
      makeMetadata({ step: 7 }),
      {},
    )

    const latest = await saver.getTuple({ configurable: { thread_id: threadId } })
    expect(latest!.checkpoint.id).toBe('ns-root') // 不被 subgraph ns 干扰
    const sub = await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_ns: 'subgraph-1' },
    })
    expect(sub!.checkpoint.id).toBe('ns-sub')
    expect(sub!.metadata!.step).toBe(7)
  })

  it('putWrites → getTuple.pendingWrites 组装（多 task 多 channel）', async () => {
    const threadId = 't-pending-writes'
    await seedThread(threadId)
    const config = { configurable: { thread_id: threadId, checkpoint_id: 'ckpt-w' } }
    await saver.put(
      { configurable: { thread_id: threadId } },
      makeCheckpoint('ckpt-w'),
      makeMetadata(),
      {},
    )
    await saver.putWrites(config, [['channelA', 'value-a1']], 'task-1')
    await saver.putWrites(
      config,
      [
        ['channelA', 'value-a2'],
        ['channelB', { deep: ['object', 1] }],
      ],
      'task-2',
    )

    const tuple = await saver.getTuple({ configurable: { thread_id: threadId, checkpoint_id: 'ckpt-w' } })
    expect(tuple!.pendingWrites).toHaveLength(3)
    // [taskId, channel, value] 三元组，值经 serde round-trip
    expect(tuple!.pendingWrites).toContainEqual(['task-1', 'channelA', 'value-a1'])
    expect(tuple!.pendingWrites).toContainEqual(['task-2', 'channelA', 'value-a2'])
    expect(tuple!.pendingWrites).toContainEqual(['task-2', 'channelB', { deep: ['object', 1] }])
  })

  it('WRITES_IDX_MAP 特殊 channel 负 idx：__error__/__interrupt__ 落表负值，正 idx 幂等、负 idx 覆盖', async () => {
    const threadId = 't-writes-idx'
    await seedThread(threadId)
    const config = { configurable: { thread_id: threadId, checkpoint_id: 'ckpt-idx' } }
    await saver.put(
      { configurable: { thread_id: threadId } },
      makeCheckpoint('ckpt-idx'),
      makeMetadata(),
      {},
    )

    // 契约核对：本票从 checkpoint 包导入该映射（PoC 三坑之三——不自造）
    expect(WRITES_IDX_MAP['__error__']).toBeLessThan(0)
    expect(WRITES_IDX_MAP['__interrupt__']).toBeLessThan(0)

    await saver.putWrites(
      config,
      [
        ['channelA', 'first'],
        ['__error__', { message: 'boom-1' }],
        ['__interrupt__', { payload: 1 }],
      ],
      'task-e',
    )
    // 重复写：普通 channel 正 idx 幂等跳过（值不变），特殊 channel 负 idx 覆盖
    await saver.putWrites(
      config,
      [
        ['channelA', 'second-ignored'],
        ['__error__', { message: 'boom-2' }],
      ],
      'task-e',
    )

    const rows = await prisma.checkpointWrite.findMany({
      where: { threadId, checkpointId: 'ckpt-idx' },
      orderBy: [{ taskId: 'asc' }, { idx: 'asc' }],
    })
    expect(rows).toHaveLength(3) // 幂等：channelA 仍一行
    const byChannel = new Map(rows.map((r) => [r.channel, r]))
    expect(byChannel.get('channelA')!.idx).toBe(0)
    expect(byChannel.get('channelA')!.blob).toEqual(
      new Uint8Array(await saver.serde.dumpsTyped('first').then(([, b]) => b)),
    )
    expect(byChannel.get('__error__')!.idx).toBe(WRITES_IDX_MAP['__error__'])
    expect(byChannel.get('__interrupt__')!.idx).toBe(WRITES_IDX_MAP['__interrupt__'])

    const tuple = await saver.getTuple({ configurable: { thread_id: threadId, checkpoint_id: 'ckpt-idx' } })
    const errorWrite = tuple!.pendingWrites!.find((w) => w[1] === '__error__')
    expect(errorWrite![2]).toEqual({ message: 'boom-2' }) // 覆盖生效
    const normalWrite = tuple!.pendingWrites!.find((w) => w[1] === 'channelA')
    expect(normalWrite![2]).toBe('first') // 幂等生效
  })

  it('list：thread 内倒序 + limit + before + metadata filter', async () => {
    const threadId = 't-list'
    await seedThread(threadId)
    for (const [i, id] of ['L-1', 'L-2', 'L-3', 'L-4'].entries()) {
      await saver.put(
        i === 0
          ? { configurable: { thread_id: threadId } }
          : { configurable: { thread_id: threadId, checkpoint_id: `L-${i}` } },
        makeCheckpoint(id),
        makeMetadata({ step: i, source: i % 2 === 0 ? 'loop' : 'update' }),
        {},
      )
    }

    const all = await collectList(saver.list({ configurable: { thread_id: threadId } }))
    expect(all.map((t) => t.checkpoint.id)).toEqual(['L-4', 'L-3', 'L-2', 'L-1'])

    const limited = await collectList(saver.list({ configurable: { thread_id: threadId } }, { limit: 2 }))
    expect(limited.map((t) => t.checkpoint.id)).toEqual(['L-4', 'L-3'])

    // before：早于 L-3（字典序）的 checkpoint
    const before = await collectList(
      saver.list(
        { configurable: { thread_id: threadId } },
        { before: { configurable: { thread_id: threadId, checkpoint_id: 'L-3' } } },
      ),
    )
    expect(before.map((t) => t.checkpoint.id)).toEqual(['L-2', 'L-1'])

    // step 1(L-2)/3(L-4) 的 source = update；list 倒序输出
    const filtered = await collectList(
      saver.list(
        { configurable: { thread_id: threadId } },
        { filter: { source: 'update' } },
      ),
    )
    expect(filtered.map((t) => t.checkpoint.id)).toEqual(['L-4', 'L-2'])

    // 每条 tuple 带完整 pendingWrites / parentConfig 组装
    const withParent = await collectList(
      saver.list({ configurable: { thread_id: threadId } }, { limit: 1 }),
    )
    expect(withParent[0].parentConfig).toEqual({
      configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'L-3' },
    })
  })

  it('list：config 无 thread_id → 跨 thread 枚举（官方 saver 语义）', async () => {
    await seedThread('t-list-x')
    await seedThread('t-list-y')
    await saver.put(
      { configurable: { thread_id: 't-list-x' } },
      makeCheckpoint('X-1'),
      makeMetadata(),
      {},
    )
    await saver.put(
      { configurable: { thread_id: 't-list-y' } },
      makeCheckpoint('Y-1'),
      makeMetadata(),
      {},
    )
    const all = await collectList(saver.list({ configurable: {} }))
    const ids = all.map((t) => t.checkpoint.id).sort()
    expect(ids).toEqual(['X-1', 'Y-1'])
    expect(all.every((t) => t.config.configurable!.thread_id !== undefined)).toBe(true)
  })

  it('deleteThread：清 checkpoints + checkpoint_writes，sessions 行与其余 thread 不动', async () => {
    await seedThread('t-del-a')
    await seedThread('t-del-b')
    const cfgA = { configurable: { thread_id: 't-del-a', checkpoint_id: 'ckpt-del-a' } }
    await saver.put({ configurable: { thread_id: 't-del-a' } }, makeCheckpoint('ckpt-del-a'), makeMetadata(), {})
    await saver.putWrites(cfgA, [['ch', 1]], 'task-1')
    await saver.put({ configurable: { thread_id: 't-del-b' } }, makeCheckpoint('ckpt-del-b'), makeMetadata(), {})

    await saver.deleteThread('t-del-a')

    expect(await prisma.checkpoint.count({ where: { threadId: 't-del-a' } })).toBe(0)
    expect(await prisma.checkpointWrite.count({ where: { threadId: 't-del-a' } })).toBe(0)
    // 其余 thread 不动
    expect(await prisma.checkpoint.count({ where: { threadId: 't-del-b' } })).toBe(1)
    // sessions 行是产品面（runner 管生命周期），deleteThread 不动
    expect(await prisma.session.count({ where: { id: 't-del-a' } })).toBe(1)
    // 删后 getTuple/list 均空
    expect(await saver.getTuple({ configurable: { thread_id: 't-del-a' } })).toBeUndefined()
    expect(await collectList(saver.list({ configurable: { thread_id: 't-del-a' } }))).toEqual([])
  })

  it('getDeltaChannelHistory：基类默认实现沿 parentConfig 链可 walk（零侵入接入证据）', async () => {
    const threadId = 't-delta-history'
    await seedThread(threadId)
    await saver.put(
      { configurable: { thread_id: threadId } },
      makeCheckpoint('d-1', { channel_values: { foo: 'seed' } }),
      makeMetadata({ step: 0 }),
      {},
    )
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_id: 'd-1' } },
      makeCheckpoint('d-2', { channel_values: { foo: 'seed' } }),
      makeMetadata({ step: 1 }),
      {},
    )
    await saver.putWrites(
      { configurable: { thread_id: threadId, checkpoint_id: 'd-1' } },
      [['foo', 'increment-1']],
      'task-d',
    )

    const history = await saver.getDeltaChannelHistory({
      config: { configurable: { thread_id: threadId, checkpoint_id: 'd-2' } },
      channels: ['foo'],
    })
    // SDK beta 契约：writes 沿父链收集（oldest→newest），seed = 最近祖先的 channel_values
    expect(history.foo).toBeDefined()
    expect(history.foo.writes).toContainEqual(['task-d', 'foo', 'increment-1'])
    expect(history.foo.seed).toBe('seed')
  })
})
