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

  it('put：copyCheckpoint 白名单归一化——额外字段不落 blob（镜像官方 MemorySaver.put）', async () => {
    const threadId = 't-normalized'
    await seedThread(threadId)
    // runtime 传入带白名单外字段的 checkpoint（异常路径防御）
    const dirty = {
      ...makeCheckpoint('ckpt-dirty', { channel_values: { x: 1 } }),
      stray: 'pollution',
    } as Checkpoint
    await saver.put({ configurable: { thread_id: threadId } }, dirty, makeMetadata(), {})
    const tuple = await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_id: 'ckpt-dirty' },
    })
    expect(tuple!.checkpoint).toEqual(makeCheckpoint('ckpt-dirty', { channel_values: { x: 1 } }))
    expect('stray' in tuple!.checkpoint).toBe(false)
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

// #747 B 节 retention：「单 thread checkpoint 总量 >100MB 护栏清最老非活跃分支」。
// seam = saver 公共 API（构造器注入小配额代替 100MB 规格值——测试可构造「超限」数据）；
// 驱逐经 put 自动触发（护栏必须在写路径生效）。活性判据 = sessions.activeCheckpointId 指针
// 的祖先链（checkpointChain.ts 单一来源）；指针缺失 → 缺省活性 tip = 最新未归档 checkpoint。
describe('PrismaCheckpointSaver retention 护栏（#747 B 节 · 100MB/thread）', () => {
  let dbDir: string
  let prisma: PrismaClient
  let saver: PrismaCheckpointSaver
  /** 单个 filler 10_000 字符 checkpoint 的落库 blob 字节数（beforeAll 实测校准——JSON 头部
   * 开销计入 B，配额/尺寸断言全以 B 为锚，serde 实现细节变化不影响测试） */
  let B: number
  const S = 10_000

  beforeAll(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'ckpt-retention-test-'))
    const dbPath = path.join(dbDir, 'test.db')
    runDbScript('apply-schema.mjs', dbPath)
    prisma = createPrismaClient(`file:${dbPath}`)
    // 校准 saver：配额拉满防校准 put 自身触发驱逐
    const calSaver = new PrismaCheckpointSaver(prisma, undefined, {
      retentionQuotaBytes: Number.MAX_SAFE_INTEGER,
    })
    await prisma.user.upsert({
      where: { id: OWNER },
      update: {},
      create: { id: OWNER, username: 'saver-owner' },
    })
    await prisma.session.upsert({
      where: { id: 't-retention-cal' },
      update: {},
      create: { id: 't-retention-cal', ownerId: OWNER, containerId: 'sandbox-cal' },
    })
    const filler = new Uint8Array(S).fill(0x78) // 'x' × S —— 字符串 filler 无转义膨胀
    await calSaver.put(
      { configurable: { thread_id: 't-retention-cal' } },
      makeCheckpoint('20261000-000000-CAL', { channel_values: { payload: new TextDecoder().decode(filler) } }),
      makeMetadata(),
      {},
    )
    const calRow = await prisma.checkpoint.findUnique({
      where: {
        threadId_checkpointNs_checkpointId: {
          threadId: 't-retention-cal',
          checkpointNs: '',
          checkpointId: '20261000-000000-CAL',
        },
      },
    })
    B = calRow!.blob.length
    // 配额 = 4.5B：4 个 B 尺寸 put 不触发（4B ≤ 4.5B），第 5 个触发并恰驱逐 1 行
    saver = new PrismaCheckpointSaver(prisma, undefined, { retentionQuotaBytes: Math.floor(4.5 * B) })
  })

  beforeEach(async () => {
    await prisma.checkpointWrite.deleteMany({})
    await prisma.checkpoint.deleteMany({})
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dbDir, { recursive: true, force: true })
  })

  async function seedThread(id: string): Promise<void> {
    await prisma.session.upsert({
      where: { id },
      update: {},
      create: { id, ownerId: OWNER, containerId: `sandbox-${id}` },
    })
  }

  /** 造一个 blob 尺寸 ≈ size 字节的 checkpoint（'x' 重复 size——JSON 串无转义，落库 ≈ B 锚） */
  async function putSized(
    threadId: string,
    id: string,
    parentId: string | undefined,
    size: number,
  ): Promise<void> {
    await saver.put(
      {
        configurable: {
          thread_id: threadId,
          ...(parentId !== undefined ? { checkpoint_id: parentId } : {}),
        },
      },
      makeCheckpoint(id, { channel_values: { payload: 'x'.repeat(size) } }),
      makeMetadata(),
      {},
    )
  }

  const ckptCount = (threadId: string): Promise<number> =>
    prisma.checkpoint.count({ where: { threadId } })

  it('总量超配额 → put 自动驱逐最老非活跃分支（活跃链与较新非活跃分支保留）', async () => {
    const threadId = 't-retention-evict'
    await seedThread(threadId)
    // 拓扑：M1 根；活跃主线 M1→M2（M2 最新 = 缺省活性 tip）；O 分支 M1→O1→O2（最老）；
    // N1 较新分支 M1→N1。5×B > 4.5B 于 M2 put 触发；驱逐最老非活跃 O1 后 4B ≤ 配额即止。
    await putSized(threadId, '20261001-000001-M1', undefined, S)
    await putSized(threadId, '20261001-000002-O1', '20261001-000001-M1', S)
    await putSized(threadId, '20261001-000003-O2', '20261001-000002-O1', S)
    await putSized(threadId, '20261001-000004-N1', '20261001-000001-M1', S)
    // 被驱逐候选挂 pending writes——驱逐须连 writes 一并清（Loose 引用防孤儿）
    await saver.putWrites(
      { configurable: { thread_id: threadId, checkpoint_id: '20261001-000002-O1' } },
      [['ch', 'orphan-guard']],
      'task-ret',
    )
    await putSized(threadId, '20261001-000005-M2', '20261001-000001-M1', S)

    const remaining = await prisma.checkpoint.findMany({
      where: { threadId },
      select: { checkpointId: true },
    })
    const ids = remaining.map((r) => r.checkpointId).sort()
    // 最老非活跃分支 O1 被驱逐；O2（同分支较新行）、N1（较新分支）、活跃链 M1/M2 保留
    expect(ids).toEqual([
      '20261001-000001-M1',
      '20261001-000003-O2',
      '20261001-000004-N1',
      '20261001-000005-M2',
    ])
    expect(await prisma.checkpointWrite.count({ where: { threadId } })).toBe(0)
  })

  it('activeCheckpointId 指针（rewind 场景）→ 指针祖先链整体保留，最老非活跃行被驱逐', async () => {
    const threadId = 't-retention-pointer'
    await seedThread(threadId)
    // A1→A2 主线；B1 从 A1 分叉（rewind 锚点）。指针 = B1 后活性链 = {B1, A1}，A2 变最老非活跃。
    await putSized(threadId, '20261002-000001-A1', undefined, S)
    await putSized(threadId, '20261002-000002-A2', '20261002-000001-A1', S)
    await putSized(threadId, '20261002-000003-B1', '20261002-000001-A1', S)
    await prisma.session.update({
      where: { id: threadId },
      data: { activeCheckpointId: '20261002-000003-B1' },
    })
    // C1（2B 尺寸）从 B1 续跑：3B + 2B > 4.5B → 驱逐 A2 后 3B + B ≤ 4.5B 止。
    // C1 虽在指针链外（非锚）且最新，但「最老先行」只清到 A2 即降回配额内。
    await putSized(threadId, '20261002-000004-C1', '20261002-000003-B1', 2 * S)

    const remaining = await prisma.checkpoint.findMany({
      where: { threadId },
      select: { checkpointId: true },
    })
    const ids = remaining.map((r) => r.checkpointId).sort()
    expect(ids).toEqual([
      '20261002-000001-A1',
      '20261002-000003-B1',
      '20261002-000004-C1',
    ])
  })

  it('归档行不计入总量（#770 软删行永不物理删、无 GC——只有未归档总量可驱动驱逐）', async () => {
    const threadId = 't-retention-archived'
    await seedThread(threadId)
    // 活跃主线 r1→m1（+触发 put t1）；非活跃分支 r1→d1（d1 较老 = 合法驱逐候选）。
    // a1/a2（各 2B）随后置 archivedAt（rewind 被放弃路线软删档——永不物理删、无 GC）。
    // t1 put 后裸总量 = 未归档 4B + 归档 4B = 8B > 4.5B；未归档总量 = 4B ≤ 4.5B。
    // 旧缺陷：归档计入总量 → 超配额触发驱逐、唯一非活跃候选 d1 被逐（语义错：B 节 retention
    // 是「总量超配额清最老非活跃分支」的应清总量口径，归档行不计入）；修正：零驱逐。
    const bigSaver = new PrismaCheckpointSaver(prisma, undefined, {
      retentionQuotaBytes: Number.MAX_SAFE_INTEGER,
    })
    const bigPut = (id: string, parent: string | undefined, size: number): Promise<unknown> =>
      bigSaver.put(
        {
          configurable: {
            thread_id: threadId,
            ...(parent !== undefined ? { checkpoint_id: parent } : {}),
          },
        },
        makeCheckpoint(id, { channel_values: { payload: 'x'.repeat(size) } }),
        makeMetadata(),
        {},
      )
    await bigPut('20261007-000000-r1', undefined, S)
    await bigPut('20261007-000001-d1', '20261007-000000-r1', S)
    await bigPut('20261007-000002-m1', '20261007-000000-r1', S)
    await bigPut('20261007-000003-a1', undefined, 2 * S)
    await bigPut('20261007-000004-a2', undefined, 2 * S)
    await prisma.checkpoint.updateMany({
      where: { threadId, checkpointId: { in: ['20261007-000003-a1', '20261007-000004-a2'] } },
      data: { archivedAt: new Date() },
    })
    // t1（B，m1 之子）put 触发写路径护栏：修正后未归档 4B ≤ 4.5B → 零驱逐。
    // 旧实现裸总量 8B > 配额会把 d1（唯一非活跃候选）逐出——本断言在旧实现下红。
    await putSized(threadId, '20261007-000005-t1', '20261007-000002-m1', S)
    const remaining = await prisma.checkpoint.findMany({ where: { threadId } })
    const byId = new Map(remaining.map((r) => [r.checkpointId, r]))
    // 全量 6 行保留（含非活跃分支 d1——未归档总量未超配额，驱逐不触发）；归档行原样保留
    expect(remaining.length).toBe(6)
    expect(byId.get('20261007-000001-d1')!.archivedAt).toBeNull()
    expect(byId.get('20261007-000005-t1')!.archivedAt).toBeNull()
    expect(byId.get('20261007-000003-a1')!.archivedAt).not.toBeNull()
    expect(byId.get('20261007-000004-a2')!.archivedAt).not.toBeNull()
  })

  it('rewind 后 run 进行中：指针后代（在飞写入头）不在祖先链上但不可驱逐', async () => {
    const threadId = 't-retention-inflight'
    await seedThread(threadId)
    // A1 根 → A2 旧主线。rewind 到 A1（生产面：rewindSession 差集归档 A2 + 指针 = A1，
    // 此处直接置位模拟终态）；在飞 run 从 A1 续跑写 C1→C2→C3→C4（指针仅 run 终态推进——
    // 进行中 C1..C4 全在指针后代、不在祖先链）。非归档总量 A1+C1..C4 = 5B > 4.5B 于
    // C4 put 触发护栏。旧活性（祖先链）下 C1/C2 是最老非活跃候选会被逐出（在飞 run 自身
    // checkpoint 被运行中删除 → resume 落空 = PoC 坑「静默 no-op 假 done」）——本断言旧实现下红。
    const bigSaver = new PrismaCheckpointSaver(prisma, undefined, {
      retentionQuotaBytes: Number.MAX_SAFE_INTEGER,
    })
    await bigSaver.put(
      { configurable: { thread_id: threadId } },
      makeCheckpoint('20261008-000001-A1', { channel_values: { payload: 'x'.repeat(S) } }),
      makeMetadata(),
      {},
    )
    await bigSaver.put(
      { configurable: { thread_id: threadId, checkpoint_id: '20261008-000001-A1' } },
      makeCheckpoint('20261008-000002-A2', { channel_values: { payload: 'x'.repeat(S) } }),
      makeMetadata(),
      {},
    )
    await prisma.session.update({
      where: { id: threadId },
      data: { activeCheckpointId: '20261008-000001-A1' },
    })
    await prisma.checkpoint.updateMany({
      where: { threadId, checkpointId: '20261008-000002-A2' },
      data: { archivedAt: new Date() },
    })
    await putSized(threadId, '20261008-000003-C1', '20261008-000001-A1', S)
    await putSized(threadId, '20261008-000004-C2', '20261008-000003-C1', S)
    await putSized(threadId, '20261008-000005-C3', '20261008-000004-C2', S)
    await putSized(threadId, '20261008-000006-C4', '20261008-000005-C3', S)

    const remaining = await prisma.checkpoint.findMany({
      where: { threadId },
      select: { checkpointId: true },
    })
    // 在飞后代（含最老的 C1）+ 指针祖先 A1 全保留；被放弃 A2 维持归档态不被触碰
    expect(remaining.map((r) => r.checkpointId).sort()).toEqual([
      '20261008-000001-A1',
      '20261008-000002-A2',
      '20261008-000003-C1',
      '20261008-000004-C2',
      '20261008-000005-C3',
      '20261008-000006-C4',
    ])
    const a2 = await prisma.checkpoint.findFirstOrThrow({
      where: { threadId, checkpointId: '20261008-000002-A2' },
      select: { archivedAt: true },
    })
    expect(a2.archivedAt).not.toBeNull()
  })

  it('总量 ≤ 配额 → 零驱逐（护栏不碰任何行）', async () => {
    const threadId = 't-retention-under'
    await seedThread(threadId)
    await putSized(threadId, '20261003-000001-a', undefined, S)
    await putSized(threadId, '20261003-000002-b', '20261003-000001-a', S)
    expect(await ckptCount(threadId)).toBe(2)
    expect(await prisma.checkpointWrite.count({ where: { threadId } })).toBe(0)
  })

  it('活跃链自身超限（无非活跃候选）→ 活跃分支保留、驱逐 no-op', async () => {
    const threadId = 't-retention-active-only'
    await seedThread(threadId)
    // 单链 4 行 × 2B 尺寸：第 3 put 起超限（3B+B > 4.5B），但无非活跃行可驱逐 → 全保留
    await putSized(threadId, '20261004-000001-a', undefined, 2 * S)
    await putSized(threadId, '20261004-000002-b', '20261004-000001-a', 2 * S)
    await putSized(threadId, '20261004-000003-c', '20261004-000002-b', 2 * S)
    await putSized(threadId, '20261004-000004-d', '20261004-000003-c', 2 * S)
    expect(await ckptCount(threadId)).toBe(4)
  })

  it('配额内总量 → put 写路径护栏零驱逐（零驱逐锚：全部行原样保留）', async () => {
    const threadId = 't-retention-report'
    await seedThread(threadId)
    await putSized(threadId, '20261005-000001-a', undefined, S)
    await putSized(threadId, '20261005-000002-b', '20261005-000001-a', S)
    // 2B ≤ 4.5B：两次 put 各自内嵌触发护栏检查，零驱逐（行全保留 = 零报告的可观测面）
    const remaining = await prisma.checkpoint.findMany({
      where: { threadId },
      select: { checkpointId: true },
    })
    expect(remaining.map((r) => r.checkpointId).sort()).toEqual([
      '20261005-000001-a',
      '20261005-000002-b',
    ])
  })

  it('超额 → put 写路径护栏多行驱逐至配额内（驱逐行数与字节数的可观测锚）', async () => {
    const threadId = 't-retention-report-over'
    await seedThread(threadId)
    // 拓扑：r1 根；r2/r3/r4 全从 r1 分叉——活性 tip = 最新 r4，活性链 {r4, r1}，
    // 非活跃候选 r2、r3（升序）。前 3 行经 MAX 配额 saver seed（不触发自动驱逐），
    // 第 4 行经配额 saver put——写路径内嵌护栏自动触发：4×2B > 4.5B → 逐行驱逐
    // r2、r3 → 4B ≤ 4.5B 止。
    const bigSaver = new PrismaCheckpointSaver(prisma, undefined, {
      retentionQuotaBytes: Number.MAX_SAFE_INTEGER,
    })
    for (const [i, id] of ['rr1', 'rr2', 'rr3'].entries()) {
      await bigSaver.put(
        {
          configurable: {
            thread_id: threadId,
            ...(i > 0 ? { checkpoint_id: '20261006-000001-rr1' } : {}),
          },
        },
        makeCheckpoint(`20261006-00000${i + 1}-${id}`, {
          channel_values: { payload: 'x'.repeat(2 * S) },
        }),
        makeMetadata(),
        {},
      )
    }
    await putSized(threadId, '20261006-000004-rr4', '20261006-000001-rr1', 2 * S)

    const remaining = await prisma.checkpoint.findMany({ where: { threadId } })
    expect(remaining.map((r) => r.checkpointId).sort()).toEqual([
      '20261006-000001-rr1',
      '20261006-000004-rr4',
    ])
    // 驱逐量锚（对齐原报告断言口径，经行状态观测）：4 行 → 逐出 2 行；
    // 每行 blob = 2S + δ（δ = B − S）→ 剩余 2 行字节和 = 2×(2S+δ)。
    expect(4 - remaining.length).toBe(2)
    expect(remaining.reduce((n, r) => n + r.blob.length, 0)).toBe(2 * (2 * S + (B - S)))
  })
})
