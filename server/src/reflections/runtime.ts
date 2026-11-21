// reflections 运行时装配（#1080 · RF-T04；#1082 · RF-T06 记录检索）。
//
// 生产组合根只在内部验证接缝注入（父规格：两个新工具统一等待完整门禁，不提前对用户开放）。
// dbPath 存在时装配真实只读执行器 + 独立主请求额度账本；缺省保持草稿链路内部接缝。

import type { PrismaClient } from '../generated/prisma/client'
import { PrismaReflectionStore } from './prismaAdapter'
import { PrismaReflectionBudgetLedger } from './budgetLedger'
import { ProcessReflectionQuery } from './query'
import type { ReflectionQueryPort } from './model'
import { ReflectionService, type ReflectionServiceOptions } from './service'

export interface ReflectionsRuntimeOptions extends Omit<ReflectionServiceOptions, 'query'> {
  /** 可信 SQLite 路径（生产由组合根传入）；存在即启用真实只读执行器与额度账本。 */
  readonly dbPath?: string
  readonly query?: ReflectionQueryPort
  readonly queryOptions?: { maxGlobal?: number; maxPerUser?: number; cooperativeMs?: number; hardMs?: number }
}

export interface ReflectionsPort {
  analysisCompleted: PrismaReflectionStore['analysisCompleted']
  completeAnalysis: PrismaReflectionStore['completeAnalysis']
  execute: ReflectionService['execute']
  confirmTurn: ReflectionService['confirmTurn']
  displayBodyText: ReflectionService['displayBodyText']
  draftBodyText: ReflectionService['draftBodyText']
  recordBodyText: ReflectionService['recordBodyText']
  bindInFlightEvidence: PrismaReflectionStore['bindInFlightEvidence']
  /** true = 解析不到稳定主请求身份即关闭记录增强（不重新发放额度）。 */
  readonly requiresRequestIdentity: boolean
}

export interface ReflectionsRuntime {
  readonly store: PrismaReflectionStore
  readonly service: ReflectionService
  readonly port: ReflectionsPort
  /** 测试验证缝：真实只读执行器（未装配时 undefined）。 */
  readonly query?: ReflectionQueryPort
  dispose(): void
}

export function createReflectionsRuntime(
  prisma: PrismaClient,
  options: ReflectionsRuntimeOptions = {},
  storeOptions: ConstructorParameters<typeof PrismaReflectionStore>[1] = {},
): ReflectionsRuntime {
  const query = options.query ?? (options.dbPath
    ? new ProcessReflectionQuery({ dbPath: options.dbPath, ...options.queryOptions })
    : undefined)
  const budget = options.budget ?? (query ? new PrismaReflectionBudgetLedger(prisma) : undefined)
  const store = new PrismaReflectionStore(prisma, { clock: options.clock, ...storeOptions })
  const service = new ReflectionService(store, store, {
    ...options,
    ...(query ? { query } : {}),
    ...(budget ? { budget } : {}),
  })
  const port: ReflectionsPort = {
    analysisCompleted: context => store.analysisCompleted(context),
    completeAnalysis: context => store.completeAnalysis(context),
    execute: (context, request, signal) => service.execute(context, request, signal),
    confirmTurn: (context, classifier) => service.confirmTurn(context, classifier),
    displayBodyText: (ownerId, displayId) => service.displayBodyText(ownerId, displayId),
    draftBodyText: (ownerId, draftId, version) => service.draftBodyText(ownerId, draftId, version),
    recordBodyText: (context, recordId, version) => service.recordBodyText(context, recordId, version),
    bindInFlightEvidence: (p) => store.bindInFlightEvidence(p),
    requiresRequestIdentity: budget !== undefined,
  }
  return { store, service, port, ...(query ? { query } : {}), dispose: () => service.dispose() }
}
