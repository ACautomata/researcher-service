// 外层存储适配：只清反思工具输入，不改用户引用或普通回答。JSON 为现役 checkpoint serializer 合同。
import type { Prisma, PrismaClient } from '../generated/prisma/client'
import { REFLECTION_TOOL_NAME, REFLECTION_SOURCE_INVALID_REASONS } from './values'
type Tx = Prisma.TransactionClient
type Row = Record<string, unknown>
const isRow = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value)
const PLACEHOLDER = '[反思工具输入已删除]'

function walk(value: unknown, visit: (row: Row) => void): void {
  if (Array.isArray(value)) { for (const item of value) walk(item, visit) }
  else if (isRow(value)) {
    visit(value)
    for (const item of Object.values(value)) walk(item, visit)
  }
}
function referencesDraft(value: unknown, draftIds: ReadonlySet<string>): boolean {
  let found = false
  walk(value, row => { if (typeof row.draft_id === 'string' && draftIds.has(row.draft_id)) found = true })
  return found
}
function resultValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return null }
}
function resultCallIds(value: unknown, draftIds: ReadonlySet<string>): Set<string> {
  const calls = new Set<string>()
  walk(value, row => {
    if (row.name !== REFLECTION_TOOL_NAME) return
    const id = row.tool_call_id ?? row.toolCallId
    if (typeof id === 'string' && referencesDraft(resultValue(row.content ?? row.details), draftIds)) calls.add(id)
  })
  return calls
}
function redact(value: unknown, ids: ReadonlySet<string>): boolean {
  let changed = false
  walk(value, row => {
    const fn = isRow(row.function) ? row.function : undefined
    const id = row.id ?? row.toolCallId
    if (typeof id !== 'string' || !ids.has(id) || (row.name !== REFLECTION_TOOL_NAME && fn?.name !== REFLECTION_TOOL_NAME)) return
    if ('args' in row) { row.args = { operation: 'deleted' }; changed = true }
    if ('input' in row) { row.input = typeof row.input === 'string' ? PLACEHOLDER : { operation: 'deleted' }; changed = true }
    if (fn && 'arguments' in fn) { fn.arguments = '{"operation":"deleted"}'; changed = true }
  })
  return changed
}
function decode(type: string, blob: Uint8Array): unknown {
  if (type === 'bytes') return null
  if (type !== 'json') throw new Error('unsupported reflection checkpoint serialization')
  return JSON.parse(Buffer.from(blob).toString('utf8'))
}
function encode(value: unknown): Uint8Array<ArrayBuffer> { return new Uint8Array(Buffer.from(JSON.stringify(value))) }

/** 与硬删/草稿关闭同事务：先建立无内容调用墓碑，再清全部历史快照和待写。 */
export async function purgeReflectionToolInputs(tx: Tx, ownerId: string, draftIds: string[]): Promise<void> {
  if (!draftIds.length) return
  const ids = new Set(draftIds)
  const checkpoints = await tx.checkpoint.findMany({ where: { session: { ownerId } } })
  const writes = await tx.checkpointWrite.findMany({ where: { session: { ownerId } } })
  const messages = await tx.sessionMessage.findMany({ where: { session: { ownerId } } })
  const calls = new Map<string, Set<string>>()
  const links = await tx.reflectionToolInputLink.findMany({ where: { ownerId, draftId: { in: draftIds } } })
  for (const link of links) {
    const known = calls.get(link.threadId) ?? new Set<string>()
    known.add(link.toolCallId); calls.set(link.threadId, known)
  }
  const collect = (threadId: string, value: unknown) => {
    const known = calls.get(threadId) ?? new Set<string>()
    for (const id of resultCallIds(value, ids)) known.add(id)
    calls.set(threadId, known)
  }
  for (const row of [...checkpoints, ...writes]) collect(row.threadId, decode(row.type, row.blob))
  for (const row of messages) collect(row.sessionId, resultValue(row.attachmentsJson))
  for (const [threadId, toolIds] of calls) for (const toolCallId of toolIds) {
    await tx.reflectionToolInputLink.upsert({ where: { threadId_toolCallId: { threadId, toolCallId } }, create: { ownerId, threadId, toolCallId, redacted: true }, update: { redacted: true } })
  }
  for (const row of checkpoints) {
    const value = decode(row.type, row.blob)
    if (redact(value, calls.get(row.threadId) ?? new Set())) await tx.checkpoint.update({ where: { threadId_checkpointNs_checkpointId: { threadId: row.threadId, checkpointNs: row.checkpointNs, checkpointId: row.checkpointId } }, data: { blob: encode(value) } })
  }
  for (const row of writes) {
    const value = decode(row.type, row.blob)
    if (redact(value, calls.get(row.threadId) ?? new Set())) await tx.checkpointWrite.update({ where: { threadId_checkpointNs_checkpointId_taskId_idx: { threadId: row.threadId, checkpointNs: row.checkpointNs, checkpointId: row.checkpointId, taskId: row.taskId, idx: row.idx } }, data: { blob: encode(value) } })
  }
  for (const row of messages) {
    const value = resultValue(row.attachmentsJson)
    if (redact(value, calls.get(row.sessionId) ?? new Set())) await tx.sessionMessage.update({ where: { id: row.id }, data: { attachmentsJson: JSON.stringify(value) } })
  }
}

/** saver 的同事务写围栏；在飞图/审批恢复不能重新落入旧参数。 */
export async function redactCheckpointWrite(tx: Tx, threadId: string, type: string, blob: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (!hasReflectionInput(type, blob)) return new Uint8Array(blob)
  const tombstones = await tx.reflectionToolInputLink.findMany({ where: { threadId, redacted: true }, select: { toolCallId: true } })
  if (!tombstones.length) return new Uint8Array(blob)
  const value = decode(type, blob)
  return redact(value, new Set(tombstones.map(t => t.toolCallId))) ? encode(value) : new Uint8Array(blob)
}

/** 产品消息写口使用相同墓碑；只替换具名工具输入，普通回答不受影响。 */
export async function redactProductToolInputs(tx: Tx, threadId: string, attachmentsJson: string): Promise<string> {
  if (!attachmentsJson.includes(REFLECTION_TOOL_NAME)) return attachmentsJson
  const tombstones = await tx.reflectionToolInputLink.findMany({ where: { threadId, redacted: true }, select: { toolCallId: true } })
  if (!tombstones.length) return attachmentsJson
  const value = JSON.parse(attachmentsJson)
  return redact(value, new Set(tombstones.map(t => t.toolCallId))) ? JSON.stringify(value) : attachmentsJson
}

/** 只克隆该字段的数据，调用方消息/图状态保持原样。 */
export function redactReflectionToolInputData(value: unknown, ids: ReadonlySet<string>): unknown {
  const copy = structuredClone(value)
  redact(copy, ids)
  return copy
}

export function reflectionToolInputCallIds(value: unknown): Set<string> {
  const ids = new Set<string>()
  walk(value, row => {
    const fn = isRow(row.function) ? row.function : undefined
    if (typeof row.id === 'string' && (row.name === REFLECTION_TOOL_NAME || fn?.name === REFLECTION_TOOL_NAME)) ids.add(row.id)
  })
  return ids
}

/** 绑定与草稿写同事务，不等待工具结果/checkpoint，从而覆盖首结果落盘前的关闭。 */
export async function linkReflectionToolInput(tx: Tx, ownerId: string, draftId: string, input: { threadId: string; toolCallId: string } | undefined, draftVersion: number): Promise<void> {
  if (!input) return
  if (!await tx.session.findFirst({ where: { id: input.threadId, ownerId }, select: { id: true } })) throw new Error('reflection tool thread unavailable')
  const existing = await tx.reflectionToolInputLink.findUnique({ where: { threadId_toolCallId: input } })
  if (existing && (existing.redacted || existing.draftId !== draftId || existing.draftVersion !== draftVersion)) throw new Error('reflection tool identity already consumed')
  await tx.reflectionToolInputLink.upsert({ where: { threadId_toolCallId: input }, create: { ownerId, ...input, draftId, draftVersion }, update: {} })
}

/** 即使 outbox 尚未清理，失效证据关联的输入也不交给模型。 */
export async function redactedReflectionToolCallIds(tx: Tx, ownerId: string, threadId: string): Promise<string[]> {
  const blocked = await tx.reflectionEvidence.findMany({ where: { ownerId, reason: { in: [...REFLECTION_SOURCE_INVALID_REASONS] } }, select: { draftId: true, draftVersion: true } })
  const links = await tx.reflectionToolInputLink.findMany({ where: { ownerId, threadId } })
  const invalid = (link: { draftId: string | null; draftVersion: number | null }) => blocked.some(e => e.draftId === link.draftId && e.draftVersion === link.draftVersion)
  const ids = new Set(links.filter(link => link.redacted || invalid(link)).map(link => link.toolCallId))
  // 兼容旧快照尚无调用绑定的输入；只在有失效证据时扫描，并保留已绑定的新有效版本。
  if (blocked.length) {
    const rows = [...await tx.checkpoint.findMany({ where: { threadId, session: { ownerId } } }), ...await tx.checkpointWrite.findMany({ where: { threadId, session: { ownerId } } })]
    for (const row of rows) for (const id of resultCallIds(decode(row.type, row.blob), new Set(blocked.map(e => e.draftId)))) {
      const link = links.find(link => link.toolCallId === id)
      if (!link || link.redacted || invalid(link)) ids.add(id)
    }
  }
  return [...ids]
}

function hasReflectionInput(type: string, blob: Uint8Array): boolean {
  return type === 'json' && Buffer.from(blob).includes(REFLECTION_TOOL_NAME)
}

/** 普通图写维持原接缝；只有可能携带反思输入的写入才增加同事务墓碑复核。 */
export function withReflectionInputFence<T>(prisma: PrismaClient, type: string, blob: Uint8Array, write: (tx: Tx) => Promise<T>): Promise<T> {
  return hasReflectionInput(type, blob) ? prisma.$transaction(write) : write(prisma)
}
