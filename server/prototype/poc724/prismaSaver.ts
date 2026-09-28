// PoC #724 · THROWAWAY —— PrismaCheckpointSaver：BaseCheckpointSaver 的 Prisma(SQLite) 策略。
// 方法语义逐条镜像 MemorySaver（@langchain/langgraph-checkpoint/dist/memory.js）：
//   getTuple（指定 id / 取最新，挂 pendingWrites + parentConfig）
//   list（checkpointId 倒序，before/filter/limit 语义对齐）
//   put（copyCheckpoint → dumpsTyped，parentId = 调用 config 的 checkpoint_id）
//   putWrites（WRITES_IDX_MAP 映射 idx；idx>=0 幂等跳过已存在，idx<0 错误写覆盖）
//   deleteThread（两表级联清）
// blob 存 serde 默认 JsonPlusSerializer 产物（Bytes 列）。未镜像 _migratePendingSends（新线程恒 v4+）。

import {
  BaseCheckpointSaver,
  copyCheckpoint,
  getCheckpointId,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type CheckpointListOptions,
} from '@langchain/langgraph'
import { WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint'
import type { RunnableConfig } from '@langchain/core/runnables'
import type { PrismaClient } from '../../src/generated/prisma/client'

function conf(config: RunnableConfig) {
  const c = config.configurable ?? {}
  return {
    threadId: c.thread_id as string | undefined,
    checkpointNs: (c.checkpoint_ns as string | undefined) ?? '',
    checkpointId: c.checkpoint_id as string | undefined,
  }
}

// put/putWrites 的强校验（MemorySaver 同语义：缺 thread_id 即抛）
function confStrict(config: RunnableConfig) {
  const c = conf(config)
  if (c.threadId === undefined) {
    throw new Error('poc724: config.configurable.thread_id 缺失（put/putWrites 必须带 thread_id）')
  }
  return { ...c, threadId: c.threadId }
}

export class PrismaCheckpointSaver extends BaseCheckpointSaver {
  constructor(private prisma: PrismaClient) {
    super()
  }

  private async loadWrites(threadId: string, checkpointNs: string, checkpointId: string): Promise<PendingWrite[]> {
    const rows = await this.prisma.pocWrite.findMany({
      where: { threadId, checkpointNs, checkpointId },
    })
    return Promise.all(
      rows.map(async (r) => [r.taskId, r.channel, await this.serde.loadsTyped('json', r.blob)] as PendingWrite),
    )
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { threadId, checkpointNs, checkpointId } = conf(config)
    if (threadId === undefined) return undefined // MemorySaver 同语义：无 thread_id → undefined
    const row = checkpointId
      ? await this.prisma.pocCheckpoint.findUnique({
          where: { threadId_checkpointNs_checkpointId: { threadId, checkpointNs, checkpointId } },
        })
      : await this.prisma.pocCheckpoint.findFirst({
          where: { threadId, checkpointNs },
          orderBy: { checkpointId: 'desc' },
        })
    if (!row) return undefined
    const ckpt = (await this.serde.loadsTyped('json', row.blob)) as Checkpoint
    const pendingWrites = await this.loadWrites(row.threadId, row.checkpointNs, row.checkpointId)
    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: row.threadId,
          checkpoint_ns: row.checkpointNs,
          checkpoint_id: row.checkpointId,
        },
      },
      checkpoint: ckpt,
      metadata: (await this.serde.loadsTyped('json', row.metadata)) as CheckpointMetadata,
      pendingWrites,
    }
    if (row.parentId !== null) {
      tuple.parentConfig = {
        configurable: { thread_id: row.threadId, checkpoint_ns: row.checkpointNs, checkpoint_id: row.parentId },
      }
    }
    return tuple
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    let { before, limit, filter } = options ?? {}
    const { threadId, checkpointNs, checkpointId } = conf(config)
    const rows = await this.prisma.pocCheckpoint.findMany({
      where: {
        ...(threadId !== undefined ? { threadId } : {}),
        ...(checkpointNs !== undefined ? { checkpointNs } : {}),
        ...(checkpointId !== undefined ? { checkpointId } : {}),
      },
      orderBy: { checkpointId: 'desc' },
    })
    for (const row of rows) {
      if (before?.configurable?.checkpoint_id !== undefined && row.checkpointId >= before.configurable.checkpoint_id) {
        continue
      }
      const metadata = (await this.serde.loadsTyped('json', row.metadata)) as CheckpointMetadata
      if (filter && !Object.entries(filter).every(([k, v]) => (metadata as Record<string, unknown>)[k] === v)) continue
      if (limit !== undefined) {
        if (limit <= 0) break
        limit -= 1
      }
      const pendingWrites = await this.loadWrites(row.threadId, row.checkpointNs, row.checkpointId)
      const tuple: CheckpointTuple = {
        config: {
          configurable: {
            thread_id: row.threadId,
            checkpoint_ns: row.checkpointNs,
            checkpoint_id: row.checkpointId,
          },
        },
        checkpoint: (await this.serde.loadsTyped('json', row.blob)) as Checkpoint,
        metadata,
        pendingWrites,
      }
      if (row.parentId !== null) {
        tuple.parentConfig = {
          configurable: { thread_id: row.threadId, checkpoint_ns: row.checkpointNs, checkpoint_id: row.parentId },
        }
      }
      yield tuple
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const { threadId, checkpointNs } = confStrict(config)
    const prepared = copyCheckpoint(checkpoint)
    const [[, blob], [, meta]] = await Promise.all([
      this.serde.dumpsTyped(prepared),
      this.serde.dumpsTyped(metadata),
    ])
    await this.prisma.pocCheckpoint.upsert({
      where: {
        threadId_checkpointNs_checkpointId: {
          threadId,
          checkpointNs,
          checkpointId: prepared.id,
        },
      },
      create: {
        threadId,
        checkpointNs,
        checkpointId: prepared.id,
        parentId: conf(config).checkpointId ?? null,
        blob,
        metadata: meta,
      },
      update: {},
    })
    return {
      configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: prepared.id },
    }
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const { threadId, checkpointNs, checkpointId } = confStrict(config)
    if (checkpointId === undefined) {
      throw new Error('poc724: putWrites 需要 config.configurable.checkpoint_id')
    }
    await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const mapped = WRITES_IDX_MAP[channel] ?? idx
        const [, blob] = await this.serde.dumpsTyped(value)
        const key = {
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          idx: mapped,
        }
        if (mapped >= 0) {
          // 常规写：幂等（已存在则跳过，对齐 MemorySaver innerKeyStr in outerWrites 分支）
          try {
            await this.prisma.pocWrite.create({ data: { ...key, channel, blob } })
          } catch {
            /* P2002 冲突 = 已写入，跳过 */
          }
        } else {
          // 错误写：覆盖
          await this.prisma.pocWrite
            .update({ where: { threadId_checkpointNs_checkpointId_taskId_idx: key }, data: { channel, blob } })
            .catch(async (e: unknown) => {
              const code = (e as { code?: string }).code
              if (code !== 'P2025') throw e
              await this.prisma.pocWrite.create({ data: { ...key, channel, blob } })
            })
        }
      }),
    )
  }

  async deleteThread(threadId: string): Promise<void> {
    await Promise.all([
      this.prisma.pocCheckpoint.deleteMany({ where: { threadId } }),
      this.prisma.pocWrite.deleteMany({ where: { threadId } }),
    ])
  }
}
