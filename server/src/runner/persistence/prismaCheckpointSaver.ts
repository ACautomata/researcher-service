// #774 [#747·04] PrismaCheckpointSaver —— BaseCheckpointSaver 五方法落 Prisma/SQLite。
//
// 契约来源：@langchain/langgraph-checkpoint ~1.1.5（对齐 @langchain/langgraph ~1.4.18 依赖集，
// #747 A 节版本锁定）；行为对照同包 MemorySaver（语义锁定先例同 backend/protocol.ts）。
//
// 关键约束：
//   - PoC 三坑之三：WRITES_IDX_MAP 仅从 checkpoint 包导出（特殊 channel 负 idx 映射不自造）。
//   - checkpoint 序列化走 serde.dumpsTyped 双件 [type, blob]，与表两列一一对应（#727：
//     blob 自包含——断线补偿从 blob 反序列化重建即此字节）；metadata 单独 JSON 列（list filter 面）。
//   - putWrites 幂等语义对齐官方：同 (taskId, idx≥0) 已存在不覆盖；负 idx（ERROR/SCHEDULED/
//     INTERRUPT/RESUME）重复写覆盖。
//   - checkpoints/checkpoint_writes 的 threadId 是 Session.id 的 FK（#771），saver 不建 session
//     行（生命周期归 runner）；deleteThread 只清机制数据两表，不动 sessions 产品面（#747 B 节
//     retention：删容器级联由 orchestrator 应用层联动）。
//   - getDeltaChannelHistory 不 override——基类默认实现经 getTuple+parentConfig walk，
//     零侵入接入（beta 契约，随 SDK 演进）。

import { BaseCheckpointSaver, WRITES_IDX_MAP, copyCheckpoint, getCheckpointId } from '@langchain/langgraph-checkpoint'
import type {
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointPendingWrite,
  CheckpointTuple,
  SerializerProtocol,
} from '@langchain/langgraph-checkpoint'
import type { PrismaClient } from '../../generated/prisma/client'
import { config } from '../../config'
import { ancestorChainOf, loadCheckpointParentOf } from '../../checkpointChain'

// RunnableConfig 本地镜像 —— protocol.ts「同形镜像不引依赖」先例：@langchain/core 归 #777
// 版本锁定集，本票不提前声明（type-only import 亦不收窄该约定）。官方字段全可选，此处只
// 镜像 saver 实际消费的 configurable 面；结构化类型下与官方 RunnableConfig 双向兼容
//（#777 runner 票接入时经 satisfies 一次性对齐断言，同 protocol.ts 尾注）。
interface RunnableConfig {
  configurable?: Record<string, unknown>
}

const THREAD_ID_REQUIRED =
  'Failed to put checkpoint. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property. When using a checkpointer, you must pass a "thread_id" so the checkpointer knows which conversation thread to persist state for. Example: graph.stream(input, { configurable: { thread_id: "my-thread-id" } })'

// putWrites 的孪生错误消息（独立常量——不从 THREAD_ID_REQUIRED 字符串手术派生，官方
// MemorySaver 两处文案同构，本镜像保持行为快照一致）
const WRITES_THREAD_ID_REQUIRED =
  'Failed to put writes. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property. When using a checkpointer, you must pass a "thread_id" so the checkpointer knows which conversation thread to persist state for. Example: graph.stream(input, { configurable: { thread_id: "my-thread-id" } })'

function configurableOf(config: RunnableConfig): Record<string, unknown> {
  return (config.configurable ?? {}) as Record<string, unknown>
}

// Prisma Bytes 列为 Uint8Array<ArrayBuffer>（TS 5.7+ 泛型化）；serde 返回
// Uint8Array<ArrayBufferLike>——归一为独立 ArrayBuffer 拷贝（字节级无差别）
function toBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data)
}

// checkpoints 行形状（Prisma 返回结构的最小读取面；blob 宽化为 Uint8Array 后 serde 可接）
interface CheckpointRow {
  threadId: string
  checkpointNs: string
  checkpointId: string
  parentCheckpointId: string | null
  type: string
  blob: Uint8Array
  metadataJson: string
}

// retention 护栏（#747 B 节：单 thread checkpoint 总量 >100MB 清最老非活跃分支）——
// 驱逐结果报告（evictedBytes = 被逐 checkpoint 的 blob 字节和，含同行 writes 共清）。
// 私有类型：enforceRetention 收私有（生产唯一调用 = 同类 put() 写路径内嵌触发）后，
// 报告值不再有外部消费面——驱逐效果经库表行状态观测（测试走公共 put seam）。
interface CheckpointRetentionReport {
  readonly evictedCheckpoints: number
  readonly evictedBytes: number
}

export interface PrismaCheckpointSaverOptions {
  /** 单 thread checkpoint 总量护栏（字节）；缺省 config.runner.checkpointRetention.quotaBytes
   * （100MB 规格值）。测试注入小配额以构造「超限」数据。 */
  readonly retentionQuotaBytes?: number
}

export class PrismaCheckpointSaver extends BaseCheckpointSaver {
  private readonly retentionQuotaBytes: number

  constructor(
    private readonly prisma: PrismaClient,
    serde?: SerializerProtocol,
    opts: PrismaCheckpointSaverOptions = {},
  ) {
    super(serde)
    this.retentionQuotaBytes = opts.retentionQuotaBytes ?? config.runner.checkpointRetention.quotaBytes
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const conf = configurableOf(config)
    const threadId = conf.thread_id as string | undefined
    const checkpointNs = (conf.checkpoint_ns as string | undefined) ?? ''
    const checkpointId = getCheckpointId(config)
    if (threadId === undefined) return undefined

    const row = checkpointId
      ? await this.prisma.checkpoint.findUnique({
          where: { threadId_checkpointNs_checkpointId: { threadId, checkpointNs, checkpointId } },
        })
      : // 缺省寻址（取最新）= 未归档最新（#781 rewind 软删）：被放弃路线 checkpoint 不可被
        // recover/续跑隐式寻址（R 评审：stalled 重放无 checkpoint_id，否则会续跑进旧分支）。
        // 精确寻址不过滤——调用方自担（rewind 的 invocation 锚点由服务端校验后才入指针）。
        await this.prisma.checkpoint.findFirst({
          where: { threadId, checkpointNs, archivedAt: null },
          orderBy: { checkpointId: 'desc' },
        })
    if (!row) return undefined

    // 官方语义（MemorySaver.getTuple）：按 checkpoint_id 精确寻址时回显调用方传入的
    // config；无 id（取最新）时组装完整寻址 config（rowToTuple 缺省分支）
    return this.rowToTuple(row, checkpointId ? config : undefined)
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const conf = configurableOf(config)
    const threadId = conf.thread_id as string | undefined
    const checkpointNs = conf.checkpoint_ns as string | undefined
    const checkpointId = conf.checkpoint_id as string | undefined
    const beforeId = options?.before?.configurable?.checkpoint_id as string | undefined

    const rows = await this.prisma.checkpoint.findMany({
      where: {
        ...(threadId !== undefined ? { threadId } : {}),
        ...(checkpointNs !== undefined ? { checkpointNs } : {}),
        // checkpoint_id 等值与 before 上界并存时合并为同一键的对象条件——分键展开会同名
        // 键覆盖致等值过滤丢失（官方 MemorySaver 两约束同时生效）
        ...(checkpointId !== undefined || beforeId !== undefined
          ? {
              checkpointId: {
                ...(checkpointId !== undefined ? { equals: checkpointId } : {}),
                ...(beforeId !== undefined ? { lt: beforeId } : {}),
              },
            }
          : {}),
      },
      orderBy: { checkpointId: 'desc' },
    })

    let remaining = options?.limit
    for (const row of rows) {
      if (remaining !== undefined && remaining <= 0) break
      if (options?.filter) {
        const metaRecord = JSON.parse(row.metadataJson) as unknown as Record<string, unknown>
        const matched = Object.entries(options.filter).every(([k, v]) => metaRecord[k] === v)
        if (!matched) continue
      }
      yield await this.rowToTuple(row)
      if (remaining !== undefined) remaining -= 1
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _newVersions?: Record<string, string | number | undefined>,
  ): Promise<RunnableConfig> {
    const conf = configurableOf(config)
    const threadId = conf.thread_id as string | undefined
    if (threadId === undefined) throw new Error(THREAD_ID_REQUIRED)
    const checkpointNs = (conf.checkpoint_ns as string | undefined) ?? ''
    const parentCheckpointId = (conf.checkpoint_id as string | undefined) ?? null

    // 归一化镜像官方 MemorySaver.put（copyCheckpoint 白名单六字段）——runtime 传带额外
    // 字段的 checkpoint 时不污染 blob
    const [type, blob] = await this.serde.dumpsTyped(copyCheckpoint(checkpoint))
    const bytes = toBytes(blob)
    await this.prisma.checkpoint.upsert({
      where: {
        threadId_checkpointNs_checkpointId: {
          threadId,
          checkpointNs,
          checkpointId: checkpoint.id,
        },
      },
      create: {
        threadId,
        checkpointNs,
        checkpointId: checkpoint.id,
        parentCheckpointId,
        type,
        blob: bytes,
        metadataJson: JSON.stringify(metadata ?? {}),
      },
      update: { parentCheckpointId, type, blob: bytes, metadataJson: JSON.stringify(metadata ?? {}) },
    })
    // retention 护栏（#747 B 节）：单 thread checkpoint 总量超配额 → 清最老非活跃分支。
    // 写路径自动触发——护栏必须在每次落账时生效（非定时任务的惰性兜底下才可恢复）。
    await this.enforceRetention(threadId)
    return {
      configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpoint.id },
    }
  }

  async putWrites(config: RunnableConfig, writes: [string, unknown][], taskId: string): Promise<void> {
    const conf = configurableOf(config)
    const threadId = conf.thread_id as string | undefined
    if (threadId === undefined) {
      throw new Error(WRITES_THREAD_ID_REQUIRED)
    }
    const checkpointNs = (conf.checkpoint_ns as string | undefined) ?? ''
    const checkpointId = conf.checkpoint_id as string | undefined
    if (checkpointId === undefined) {
      throw new Error(
        'Failed to put writes. The passed RunnableConfig is missing a required "checkpoint_id" field in its "configurable" property.',
      )
    }

    for (const [index, [channel, value]] of writes.entries()) {
      const idx = WRITES_IDX_MAP[channel] ?? index
      const [type, blob] = await this.serde.dumpsTyped(value)
      const bytes = toBytes(blob)
      const where = {
        threadId_checkpointNs_checkpointId_taskId_idx: {
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          idx,
        },
      }
      // 幂等语义（对齐 MemorySaver）：正 idx 已存在不覆盖；负 idx（特殊 channel）重复写覆盖。
      // findUnique→create 非原子：SQLite 单写者（better-sqlite3 同步驱动 + 事件循环串行化）
      // 下同 (taskId, idx) 并发不成立；跨进程并发撞 P2002 的风险接受（对齐单写者 runtime
      // 假设——官方 PG saver 以 ON CONFLICT DO NOTHING 规避，SQLite adapter 无此原语）
      if (idx >= 0) {
        const existing = await this.prisma.checkpointWrite.findUnique({ where })
        if (existing) continue
        await this.prisma.checkpointWrite.create({
          data: { threadId, checkpointNs, checkpointId, taskId, idx, channel, type, blob: bytes },
        })
      } else {
        await this.prisma.checkpointWrite.upsert({
          where,
          create: { threadId, checkpointNs, checkpointId, taskId, idx, channel, type, blob: bytes },
          update: { channel, type, blob: bytes },
        })
      }
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    // checkpoint_writes 对 checkpoint 是 Loose 引用（#771 刻意不建 FK）→ 两表分别清
    await this.prisma.checkpointWrite.deleteMany({ where: { threadId } })
    await this.prisma.checkpoint.deleteMany({ where: { threadId } })
  }

  // retention 护栏（#747 B 节：「单 thread checkpoint 总量 >100MB 护栏清最老非活跃分支」）。
  // 私有：生产唯一触发面 = put() 写路径内嵌调用（写时护栏，非定时任务）；无外部调用方。
  // 语义要点：
  //   - 总量 = 未归档行 blob 字节和（archivedAt IS NULL）——归档行（#770 软删档：永不物理
  //     删、无 GC）不计入应清总量；否则归档字节永驻、超配额时驱逐全压到活跃行（R2 修复 a）。
  //   - 活性 = sessions.activeCheckpointId 指针的祖先链（checkpointChain.ts 单一来源）∪
  //     指针的未归档后代闭包。在飞维度（R2 修复 b）：rewind 后指针仅 run 终态推进
  //     （runService），进行中的写入头 = 指针后代、不在祖先链上——缺这一维，put 每 superstep
  //     触发护栏会把在飞 run 自己的 checkpoint 逐出（resume 落空 = PoC 坑「静默 no-op 假 done」，
  //     违反 B 节「活跃会话不清」）；interrupted/suspended 的 resume 锚同样落在后代闭包内。
  //     指针缺失（未 rewind 过）→ 缺省活性 tip = 最新未归档 checkpoint（同 getTuple 缺省寻址
  //     语义——续跑寻址的行恒在活性链上，护栏永不驱逐「下一个 superstep 要读的行」）。
  //   - 驱逐序 = checkpointId 升序（LangGraph checkpointId 时间前缀字典序 = 成形时序）：
  //     最老非活跃行先清，逐行减账至总量 ≤ 配额即止——分支按最老先行整体清出。
  //   - 活跃链自身超限（无非活跃候选）→ no-op：护栏不牺牲可恢复性换体积（活跃会话不清）。
  //   - 驱逐连 checkpoint_writes 同行共清（Loose 引用防孤儿）；已 archivedAt 软删行不重复
  //     处理（#770 归档行的 GC 归 rewind/refcount 机制面，本护栏只清未归档非活跃分支）。
  private async enforceRetention(threadId: string): Promise<CheckpointRetentionReport> {
    const totalRows = await this.prisma.$queryRaw<Array<{ total: bigint | number }>>`
      SELECT COALESCE(SUM(LENGTH(blob)), 0) AS total FROM checkpoints
      WHERE threadId = ${threadId} AND archivedAt IS NULL
    `
    let total = Number(totalRows[0]?.total ?? 0)
    if (total <= this.retentionQuotaBytes) return { evictedCheckpoints: 0, evictedBytes: 0 }

    const session = await this.prisma.session.findUnique({
      where: { id: threadId },
      select: { activeCheckpointId: true },
    })
    let activeTip = session?.activeCheckpointId ?? null
    if (activeTip === null) {
      const latest = await this.prisma.checkpoint.findFirst({
        where: { threadId, archivedAt: null },
        orderBy: { checkpointId: 'desc' },
        select: { checkpointId: true },
      })
      activeTip = latest?.checkpointId ?? null
    }
    const parentOf = await loadCheckpointParentOf(this.prisma, threadId)
    const activeChain =
      activeTip !== null ? ancestorChainOf((id) => parentOf.get(id) ?? null, activeTip) : new Set<string>()

    const candidates = await this.prisma.$queryRaw<
      Array<{ checkpointNs: string; checkpointId: string; parentCheckpointId: string | null; size: bigint | number }>
    >`
      SELECT checkpointNs, checkpointId, parentCheckpointId, LENGTH(blob) AS size FROM checkpoints
      WHERE threadId = ${threadId} AND archivedAt IS NULL
      ORDER BY checkpointId ASC
    `

    // 在飞维度：活性 = 祖先链 ∪ 指针后代闭包（未归档图内；候选行集自带 parent 链，单查复用）。
    // 失败 run 残留若仍挂在指针链头之下同属受护后代——保守不清（可恢复性优先），待后续
    // completed run 推进指针 / 下一次 rewind 差集归档后再成为合法候选。
    if (activeTip !== null) {
      const childrenOf = new Map<string, string[]>()
      for (const row of candidates) {
        if (row.parentCheckpointId !== null) {
          const siblings = childrenOf.get(row.parentCheckpointId)
          if (siblings) siblings.push(row.checkpointId)
          else childrenOf.set(row.parentCheckpointId, [row.checkpointId])
        }
      }
      // seen 独立于祖先集：activeTip 自身已在祖先集内，但仍须展开其子——否则后代闭包
      // 从根处断链（栈式遍历 + seen 去重同时兜脏数据成环）。
      const seen = new Set<string>([activeTip])
      const queue = [activeTip]
      while (queue.length > 0) {
        const id = queue.pop()!
        activeChain.add(id)
        for (const child of childrenOf.get(id) ?? []) {
          if (seen.has(child)) continue
          seen.add(child)
          queue.push(child)
        }
      }
    }

    let evictedCheckpoints = 0
    let evictedBytes = 0
    for (const row of candidates) {
      if (total <= this.retentionQuotaBytes) break
      if (activeChain.has(row.checkpointId)) continue
      const size = Number(row.size)
      await this.prisma.checkpointWrite.deleteMany({
        where: { threadId, checkpointNs: row.checkpointNs, checkpointId: row.checkpointId },
      })
      await this.prisma.checkpoint.delete({
        where: {
          threadId_checkpointNs_checkpointId: {
            threadId,
            checkpointNs: row.checkpointNs,
            checkpointId: row.checkpointId,
          },
        },
      })
      total -= size
      evictedCheckpoints += 1
      evictedBytes += size
    }
    return { evictedCheckpoints, evictedBytes }
  }

  // 行 → tuple 组装（getTuple/list 共用；config 显式传入 = 官方「按 checkpoint_id 精确寻址
  // 回显调用方 config」语义，缺省 = 组装完整寻址 config）
  private async rowToTuple(row: CheckpointRow, config?: RunnableConfig): Promise<CheckpointTuple> {
    const checkpoint = (await this.serde.loadsTyped(row.type, row.blob)) as Checkpoint
    const metadata = JSON.parse(row.metadataJson) as CheckpointMetadata
    const pendingWrites = await this.loadPendingWrites(row.threadId, row.checkpointNs, row.checkpointId)

    const tuple: CheckpointTuple = {
      config: config ?? {
        configurable: {
          thread_id: row.threadId,
          checkpoint_ns: row.checkpointNs,
          checkpoint_id: row.checkpointId,
        },
      },
      checkpoint,
      metadata,
      pendingWrites,
    }
    if (row.parentCheckpointId !== null) {
      tuple.parentConfig = {
        configurable: {
          thread_id: row.threadId,
          checkpoint_ns: row.checkpointNs,
          checkpoint_id: row.parentCheckpointId,
        },
      }
    }
    return tuple
  }

  private async loadPendingWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<CheckpointPendingWrite[]> {
    const rows = await this.prisma.checkpointWrite.findMany({
      where: { threadId, checkpointNs, checkpointId },
      orderBy: [{ taskId: 'asc' }, { idx: 'asc' }],
    })
    return Promise.all(
      rows.map(
        async (r) =>
          [r.taskId, r.channel, await this.serde.loadsTyped(r.type, r.blob)] as CheckpointPendingWrite,
      ),
    )
  }
}
