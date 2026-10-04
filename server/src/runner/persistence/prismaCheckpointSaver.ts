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

export class PrismaCheckpointSaver extends BaseCheckpointSaver {
  constructor(private readonly prisma: PrismaClient, serde?: SerializerProtocol) {
    super(serde)
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
