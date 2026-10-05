// 锁面包装（#785 · #747 E 节锁方案接线）：把 per-path 写锁应用到 runner 的全部破坏性写面。
//
// 两个包装层：
//   1. withWriteLocks —— SandboxBackendProtocolV2 装饰器：write/edit/delete 全方法粒度加锁
//      （edit 的 readFullText → performStringReplacement → putBuffer 读改写序必须整体在锁内，
//      否则两写之间被插写仍会丢改——这正是锁要防的竞态，故锁不在更低的 putArchive 层收敛）。
//      read/ls/readRaw/glob/grep/execute 直通：读不受锁阻塞（#769「读不限」）；execute 是
//      shell 通道，bash 写为旁路（与 exec 显式降级同哲学）。
//   2. withLockedPuts —— primitives 装饰器：putArchive 按 tar 内单文件名取文件级锁 key，
//      覆盖 ingestion 物化（ingestAttachments）与校验节点写（materializeAgentMedia）——两者
//      绕过 backend 直走原语。exec 直通（mkdir -p 非破坏性；且 exec 是 bash 通道，不锁），
//      getArchive 直通（读不限）。
//
// 覆盖审计（#785 语义层）在两个包装层同形接线：detect（锁内、op 前——journal 仍是 pre-write
// 状态，上家语义）→ op → record（op 成功后——写失败不产生覆盖，不落幻影行）。
//
// 锁 key 约定 = 会话沙箱内根相对路径（剥前导 '/'：/lab/a/b → lab/a/b），与 file_journal.path
// 「normalizeFilePath 后相对路径」同一约定（覆盖判定按 (sessionId, path) 精确 join）。会话域 =
// 沙箱所属 parent session（teammate 的 /lab 写落 parent 沙箱——互斥域随容器不随 thread；
// wiki 容器 per-user 跨会话共享，跨会话锁 V1 明确不做——同 owner 两会话并发写同 wiki path
// 不互斥，#747 230 行钉死）。
//
// 超时/取消面：后端方法协议无 throw 通道（全 {error} 结果面），锁错误转 {error: 文案}
// 回喂 agent（含 path 与持有者，agent 自行决策重试/换路径）；primitives 层无结果面约束，
// 锁错误上抛（ingestion 抛 → run.failed；materialize 自吞 → 降级 null，各自既有错误面）。

import { parseTar, normalizeTarName } from '../../files/tar'
import type { MaybePromise, SandboxBackendProtocolV2 } from '../backend/protocol'
import type { SandboxFilePrimitives } from '../backend/primitives'
import { routePath, type BackendTargets } from '../backend/paths'
import { WriteLockRegistry, WriteLockTimeoutError, type WriteLockHolder } from './registry'
import type { OverwriteAuditor } from './overwriteAudit'

// 锁上下文（调用点每次 op 现取——图实例跨 run 缓存，holder 随 run 流转不可构造期固化）。
export interface WriteLockContext {
  /** 互斥域会话（sandbox 所属 parent session；cmd.parentSessionId ?? cmd.sessionId） */
  readonly session: string
  /** 当前 thread（覆盖审计「上家 writer ≠ 本 thread」的本方身份） */
  readonly threadId: string
  /** 持有者（label 进超时报错；runId 供 releaseRun 取消清理） */
  readonly holder: WriteLockHolder
}

// 锁 key：沙箱内根相对路径（剥前导 '/'）。routePath 已归一化（折叠 // 与 . 段、拒 ..）。
export function toLockKey(absPath: string): string {
  return absPath.startsWith('/') ? absPath.slice(1) : absPath
}

// 协议结果族的错误位形状（WriteResult/EditResult/DeleteResult 皆 {error?: string} 可选位，
// 非判别联合——锁错误按同形状返回 {error: 文案}）。
type ErrorResult = { error?: string }

// 后端装饰器：write/edit/delete 锁全方法；其余直通（读/bash 旁路）。
export function withWriteLocks(
  backend: SandboxBackendProtocolV2,
  targets: BackendTargets,
  locks: WriteLockRegistry,
  ctx: () => WriteLockContext,
  auditor?: OverwriteAuditor,
): SandboxBackendProtocolV2 {
  // 锁错误 → {error} 结果面（文案面向 agent：报原始 path 与持有者，agent 自行决策
  // 重试/换路径——WriteLockTimeoutError.params 持结构化字段，此处按原始 path 重排）。
  const lockResult = (rawPath: string, op: () => MaybePromise<ErrorResult>): Promise<ErrorResult> =>
    (async () => {
      const c = ctx()
      // 非法路径不加锁：底层方法自身的错误面处理（锁不改变错误语义）
      const routed = routePath(rawPath, targets)
      if ('error' in routed) return await op()
      const key = toLockKey(routed.absPath)
      let lease
      try {
        lease = await locks.acquire(c.session, key, c.holder)
      } catch (e) {
        if (e instanceof WriteLockTimeoutError) {
          return {
            error:
              `write failed: path ${rawPath} is locked by ${e.params.holderLabel} ` +
              `(waited ${e.params.waitMs}ms) — retry after the holder finishes, or write to a different path`,
          }
        }
        return { error: `write failed: ${(e as Error).message}` }
      }
      try {
        // 覆盖审计两段式（#785）：detect 在锁内、op 前（journal 仍是 pre-write 状态——上家
        // 语义）；record 在 op 成功后（写失败不产生覆盖，不落幻影行）。审计计数不阻断写。
        const overwrite = auditor ? await auditor.detect({ sessionId: c.session, path: key, threadId: c.threadId, runId: c.holder.runId }) : null
        const result = await op()
        if (overwrite !== null && result.error === undefined) await auditor!.record(overwrite)
        return result
      } finally {
        lease.release()
      }
    })()

  return {
    get id(): string {
      return backend.id
    },
    ls: (path) => backend.ls(path),
    read: (filePath, offset, limit) => backend.read(filePath, offset, limit),
    readRaw: (filePath) => backend.readRaw(filePath),
    glob: (pattern, path) => backend.glob(pattern, path),
    grep: (pattern, path, glob, maxCount) => backend.grep(pattern, path, glob, maxCount),
    // execute（shell/bash）直通：bash 写为旁路，不入锁（#747 230 行「锁不覆盖 shell 写」）
    execute: (command) => backend.execute(command),
    write: (filePath, content) =>
      lockResult(filePath, () => backend.write(filePath, content)) as ReturnType<typeof backend.write>,
    edit: (filePath, oldString, newString, replaceAll) =>
      lockResult(filePath, () => backend.edit(filePath, oldString, newString, replaceAll)) as ReturnType<typeof backend.edit>,
    delete: (filePath) => {
      const del = backend.delete?.bind(backend)
      if (!del) return Promise.resolve({ error: 'delete not supported' })
      return lockResult(filePath, () => del(filePath)) as ReturnType<NonNullable<typeof backend.delete>>
    },
  }
}

// primitives 装饰器：putArchive 按 tar 内单文件名取文件级锁（ingestion/校验节点写面）。
// 非「单文件 tar」（多条目/目录/解析失败）→ 退化为目录级 key（宁粗勿漏——当前调用面全部
// 单文件 createTarFile）。auditor 可选：与 backend 层同一 detect/record 两段式（op 抛出
// = 写失败，不落行）。
// 刻意逐方法委派而非 {...primitives} 展开：DockerPrimitives 方法在原型上，展开会丢。
export function withLockedPuts(
  primitives: Pick<SandboxFilePrimitives, 'exec' | 'getArchive' | 'putArchive'>,
  locks: WriteLockRegistry,
  ctx: () => WriteLockContext,
  auditor?: OverwriteAuditor,
): Pick<SandboxFilePrimitives, 'exec' | 'getArchive' | 'putArchive'> {
  return {
    exec: (container, cmd, opts) => primitives.exec(container, cmd, opts),
    getArchive: (container, absPath) => primitives.getArchive(container, absPath),
    async putArchive(container, dir, tar) {
      const c = ctx()
      const entries = parseTar(tar, {})
      const file =
        entries.length === 1 && entries[0]!.type === 'file' ? normalizeTarName(entries[0]!.name) : null
      // dir 为沙箱内绝对路径（/lab/uploads/<id>）；key 与 backend 层同一约定（剥前导 '/'）
      const key = toLockKey(file !== null ? `${dir}/${file}` : dir)
      const lease = await locks.acquire(c.session, key, c.holder)
      try {
        const overwrite = auditor ? await auditor.detect({ sessionId: c.session, path: key, threadId: c.threadId, runId: c.holder.runId }) : null
        await primitives.putArchive(container, dir, tar)
        if (overwrite !== null) await auditor!.record(overwrite)
      } finally {
        lease.release()
      }
    },
  }
}
